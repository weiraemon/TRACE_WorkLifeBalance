package com.chaos.workbench;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** SAF persistence only. Work rules, Markdown encoding and Notes stay in the shared TypeScript core. */
final class DocumentStore implements AutoCloseable {
    private static final String DIR = DocumentsContract.Document.MIME_TYPE_DIR;
    private static final Set<String> SKIP = new HashSet<>(Arrays.asList(".git", ".obsidian", ".atlas", "node_modules"));
    private final Context context;
    final Uri tree;
    final String session = UUID.randomUUID().toString();
    private final String device;
    private final FileChannel lockChannel;
    private final FileLock lock;
    private boolean poisoned;
    private final Map<String, Uri> parentDirectories = new java.util.concurrent.ConcurrentHashMap<>();
    private NativeOperation operation = new NativeOperation("", event -> {});
    void operation(NativeOperation next) { operation = next; parentDirectories.clear(); }
    static final class OwnershipChanged extends IOException {
        OwnershipChanged() { super("目录含有旧安装或其他设备的授权标记，请重新选择并确认接管"); }
    }
    // Instrumentation interrupts publication at an actual persistence boundary, only in debug builds.
    static int interruptAfter = -1;
    private int boundaries;

    static String sha(byte[] bytes) throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    private static String hex(byte[] bytes) {
        char[] result = new char[bytes.length * 2];
        String digits = "0123456789abcdef";
        for (int i = 0; i < bytes.length; i++) {
            int value = bytes[i] & 255;
            result[i * 2] = digits.charAt(value >>> 4);
            result[i * 2 + 1] = digits.charAt(value & 15);
        }
        return new String(result);
    }
    static String sha(String text) throws Exception { return sha(text.getBytes(StandardCharsets.UTF_8)); }
    private static String text(byte[] bytes) throws Exception {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }
    DocumentStore(Context context, Uri tree, String device) throws Exception {
        this(context, tree, device, false, new NativeOperation("", event -> {}));
    }
    DocumentStore(Context context, Uri tree, String device, boolean reclaim, NativeOperation operation) throws Exception {
        this.operation = operation;
        this.context = context; this.tree = tree; this.device = device;
        if (!"content".equals(tree.getScheme()) || !"com.android.externalstorage.documents".equals(tree.getAuthority())
            || !DocumentsContract.isTreeUri(tree) || !DocumentsContract.getTreeDocumentId(tree).startsWith("primary:"))
            throw new IOException("首版仅支持手机内部存储的本地文件夹，请选择 Documents 下的专用目录");
        File lockFile = new File(context.getFilesDir(), "vault-" + sha(tree.toString()) + ".lock");
        lockChannel = new RandomAccessFile(lockFile, "rw").getChannel();
        FileLock acquired;
        try { acquired = lockChannel.tryLock(); }
        catch (Exception error) { lockChannel.close(); throw new IOException("同一目录正在被另一个运行时使用", error); }
        if (acquired == null) { lockChannel.close(); throw new IOException("工作目录已被占用"); }
        lock = acquired;
        try {
            operation.update("正在检查目录授权与占用", -1, -1);
            if (find(".atlas/service.lock") != null || find(".atlas/service-connecting") != null)
                throw new IOException("目录包含其他设备的运行锁，请先关闭对应程序并使用完整目录导出");
            Uri owner = find(".atlas/android-owner.json");
            boolean changedOwner = owner != null && !device.equals(new JSONObject(read(owner, 65536)).getString("device"));
            if (changedOwner && !reclaim) throw new OwnershipChanged();
            probe();
            if (changedOwner) delete(".atlas/android-owner.json");
            if (owner == null || changedOwner) writeNew(".atlas/android-owner.json", new JSONObject().put("device", device).toString());
            resume();
        } catch (Exception error) { lock.release(); lockChannel.close(); throw error; }
    }
    private synchronized void boundary() throws IOException {
        if (BuildConfig.DEBUG && interruptAfter >= 0 && ++boundaries == interruptAfter)
            throw new IOException("模拟发布中断");
    }
    private void check() throws IOException {
        operation.check();
        if (!lock.isValid()) throw new IOException("目录会话已关闭，请重新连接");
        if (poisoned) throw new IOException("上次发布未完成，请重新连接以恢复；当前输入仍保留");
    }
    private String[] parts(String path) throws IOException {
        if (path == null || path.isEmpty() || path.length() > 2000 || path.contains("\\") || path.startsWith("/"))
            throw new IOException("非法相对路径");
        String[] parts = path.split("/", -1);
        for (String part : parts)
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.matches(".*[\\x00-\\x1f:<>\"|?*].*") || part.endsWith(".") || part.endsWith(" "))
                throw new IOException("路径越界或名称无效：" + path);
        return parts;
    }
    private Uri root() { return DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree)); }
    private JSONArray children(Uri directory) throws Exception {
        operation.check();
        JSONArray result = new JSONArray();
        Uri list = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(directory));
        String[] columns = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_FLAGS, DocumentsContract.Document.COLUMN_SIZE };
        try (Cursor cursor = context.getContentResolver().query(list, columns, null, null, null, operation.signal)) {
            if (cursor == null) throw new IOException("无法读取目录，授权可能已撤销");
            Set<String> names = new HashSet<>();
            while (cursor.moveToNext()) {
                String name = cursor.getString(1);
                if (!names.add(name)) throw new IOException("目录出现重名文件，停止读写：" + name);
                result.put(new JSONObject().put("id", cursor.getString(0)).put("name", name).put("directory", DIR.equals(cursor.getString(2)))
                    .put("flags", cursor.getLong(3)).put("size", cursor.getLong(4)));
            }
        }
        return result;
    }
    private Uri child(Uri parent, String name) throws Exception {
        JSONArray siblings = children(parent);
        for (int i = 0; i < siblings.length(); i++) {
            JSONObject sibling = siblings.getJSONObject(i);
            if (!name.equals(sibling.getString("name"))) continue;
            if ((sibling.getLong("flags") & DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0) throw new IOException("不支持虚拟文档");
            return DocumentsContract.buildDocumentUriUsingTree(tree, sibling.getString("id"));
        }
        return null;
    }
    private Uri find(String path) throws Exception {
        String[] segments = parts(path);
        Uri direct = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree) + "/" + path);
        operation.check();
        try (Cursor cursor = context.getContentResolver().query(direct, new String[]{
            DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_FLAGS
        }, null, null, null, operation.signal)) {
            if (cursor == null) throw new IOException("无法读取文件，授权可能已撤销");
            if (!cursor.moveToFirst()) return null;
            if (!segments[segments.length - 1].equals(cursor.getString(0))) throw new IOException("文件提供方返回了不同名称，停止访问");
            if ((cursor.getLong(1) & DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0) throw new IOException("不支持虚拟文档");
            return direct;
        } catch (RuntimeException error) {
            // Missing descendants can raise a provider permission error. Walk only to distinguish absence from a revoked grant.
        }
        int slash = path.lastIndexOf('/');
        Uri directory = slash < 0 ? root() : find(path.substring(0, slash));
        if (directory == null) return null;
        return child(directory, segments[segments.length - 1]);
    }
    private String name(Uri uri) throws Exception {
        operation.check();
        try (Cursor cursor = context.getContentResolver().query(uri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null, operation.signal)) {
            if (cursor == null || !cursor.moveToFirst()) throw new IOException("文件已不存在");
            return cursor.getString(0);
        }
    }
    private Uri parent(String path) throws Exception {
        parts(path);
        int slash = path.lastIndexOf('/');
        if (slash < 0) return root();
        String directory = path.substring(0, slash);
        Uri cached = parentDirectories.get(directory);
        if (cached != null) return cached;
        Uri uri = find(directory);
        if (uri == null) uri = create(parent(directory), directory.substring(directory.lastIndexOf('/') + 1), DIR);
        if (!DIR.equals(context.getContentResolver().getType(uri))) throw new IOException("目标父路径不是目录");
        parentDirectories.put(directory, uri);
        return uri;
    }
    private Uri create(Uri parent, String name, String mime) throws Exception {
        operation.check();
        Uri created = DocumentsContract.createDocument(context.getContentResolver(), parent, mime, name);
        if (created == null) throw new IOException("目录提供方未能创建文件");
        if (!name.equals(name(created))) { DocumentsContract.deleteDocument(context.getContentResolver(), created); throw new IOException("出现同名冲突，停止发布"); }
        return created;
    }
    private byte[] bytes(Uri uri, int limit) throws Exception {
        operation.check();
        ParcelFileDescriptor descriptor = context.getContentResolver().openFileDescriptor(uri, "r", operation.signal);
        if (descriptor == null) throw new IOException("无法读取文件");
        operation.onCancel(() -> { try { descriptor.close(); } catch (IOException ignored) {} });
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IOException("无法读取文件");
            byte[] buffer = new byte[16384]; int count;
            while ((count = input.read(buffer)) >= 0) { operation.check(); if (output.size() + count > limit) throw new IOException("笔记超过大小限制，已停止读取"); output.write(buffer, 0, count); }
            return output.toByteArray();
        } finally { operation.onCancel(null); }
    }
    private String read(Uri uri, int limit) throws Exception { return text(bytes(uri, limit)); }
    String read(String path) throws Exception {
        check(); Uri uri = find(path); if (uri == null) throw new IOException("文件不存在：" + path);
        return read(uri, 5 * 1024 * 1024);
    }
    String fingerprint(String path) throws Exception {
        check(); Uri uri = find(path);
        return uri == null || DIR.equals(context.getContentResolver().getType(uri)) ? null : hash(uri);
    }
    private String hash(Uri uri) throws Exception {
        operation.check();
        if (uri == null) return null;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        ParcelFileDescriptor descriptor = context.getContentResolver().openFileDescriptor(uri, "r", operation.signal);
        if (descriptor == null) throw new IOException("无法读取文件");
        operation.onCancel(() -> { try { descriptor.close(); } catch (IOException ignored) {} });
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor)) {
            if (input == null) throw new IOException("无法读取文件");
            byte[] buffer = new byte[16384]; int count;
            while ((count = input.read(buffer)) >= 0) { operation.check(); digest.update(buffer, 0, count); }
        } finally { operation.onCancel(null); }
        return hex(digest.digest());
    }
    private Uri writeNew(String path, String source) throws Exception {
        Uri directory = parent(path); String[] pieces = parts(path);
        Uri uri = create(directory, pieces[pieces.length - 1], "application/x-chaos-data");
        operation.check();
        ParcelFileDescriptor descriptor = context.getContentResolver().openFileDescriptor(uri, "rw", operation.signal);
        if (descriptor == null) throw new IOException("无法写入文件");
        operation.onCancel(() -> { try { descriptor.close(); } catch (IOException ignored) {} });
        try (ParcelFileDescriptor.AutoCloseOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
            output.write(source.getBytes(StandardCharsets.UTF_8)); output.flush(); descriptor.getFileDescriptor().sync();
        } finally { operation.onCancel(null); }
        if (!sha(source).equals(hash(uri))) throw new IOException("写入校验失败，停止发布");
        return uri;
    }
    private void writeLog(String path, String source) throws Exception {
        writeNew(path + ".preparing", source);
        rename(path + ".preparing", path);
    }
    private void delete(String path) throws Exception {
        operation.check();
        Uri uri = find(path);
        if (uri != null && !DocumentsContract.deleteDocument(context.getContentResolver(), uri)) throw new IOException("文件删除失败：" + path);
    }
    private Uri rename(String source, String target) throws Exception {
        return rename(find(source), target);
    }
    private Uri rename(Uri uri, String target) throws Exception {
        operation.check();
        String[] pieces = parts(target);
        // A rename target is normally absent. One fresh parent listing avoids the provider's missing-path exception and repeat queries.
        if (child(parent(target), pieces[pieces.length - 1]) != null) throw new IOException("目标已有内容，未覆盖：" + target);
        if (uri == null) throw new IOException("待发布文件不存在");
        Uri renamed = DocumentsContract.renameDocument(context.getContentResolver(), uri, pieces[pieces.length - 1]);
        if (renamed == null || !pieces[pieces.length - 1].equals(name(renamed))) throw new IOException("重命名未得到预期文件名，停止发布");
        return renamed;
    }
    private void probe() throws Exception {
        String base = ".atlas/probe-" + UUID.randomUUID();
        String first = base + "-a", second = base + "-b", moved = base + "-c";
        try {
            writeNew(first, "CHAOS storage probe A"); writeNew(second, "CHAOS storage probe B");
            Uri duplicate = DocumentsContract.createDocument(context.getContentResolver(), parent(second), "application/x-chaos-data", second.substring(second.lastIndexOf('/') + 1));
            if (duplicate == null || duplicate.equals(find(second)) || !sha("CHAOS storage probe B").equals(hash(find(second))))
                throw new IOException("目录提供方会覆盖同名文件，拒绝启用写入");
            DocumentsContract.deleteDocument(context.getContentResolver(), duplicate);
            Uri renamed = null;
            try { renamed = DocumentsContract.renameDocument(context.getContentResolver(), find(first), second.substring(second.lastIndexOf('/') + 1)); }
            catch (Exception ignored) { /* A no-replace failure is also safe. */ }
            if (!sha("CHAOS storage probe B").equals(hash(find(second))))
                throw new IOException("目录提供方会覆盖同名文件，拒绝启用写入");
            if (renamed != null && !renamed.equals(find(second))) DocumentsContract.deleteDocument(context.getContentResolver(), renamed);
            if (find(first) == null) writeNew(first, "CHAOS storage probe A");
            rename(first, moved);
            if (!sha("CHAOS storage probe A").equals(hash(find(moved)))) throw new IOException("目录提供方无法可靠重命名");
        } finally { delete(first); delete(second); delete(moved); }
    }
    JSONArray scan() throws Exception {
        return scanTree(root(), "", false);
    }
    JSONArray scanWorkspace() throws Exception {
        check();
        Uri marker = find("ATLAS/layout.json");
        if (marker == null) return scan();
        JSONObject layout = new JSONObject(read(marker, 65536));
        if (layout.optInt("version") != 1 || !"ATLAS/records".equals(layout.optString("records")))
            throw new IOException("工作目录布局版本不支持，停止写入");
        return scanTree(find("ATLAS/records"), "ATLAS/records/", true);
    }
    private JSONArray scanTree(Uri base, String prefix, boolean canonical) throws Exception {
        check(); JSONArray result = new JSONArray();
        if (canonical) {
            result.put(new JSONObject().put("path", "ATLAS").put("directory", true));
            result.put(new JSONObject().put("path", "ATLAS/records").put("directory", true));
            result.put(new JSONObject().put("path", "ATLAS/layout.json").put("directory", false));
        }
        operation.update("正在扫描工作目录", 0, -1);
        List<java.util.concurrent.Callable<Void>> reads = new ArrayList<>();
        if (base != null) walk(base, prefix, result, 0, reads);
        java.util.concurrent.ExecutorService readers = java.util.concurrent.Executors.newFixedThreadPool(4);
        try {
            operation.update("正在读取工作文件", 0, reads.size());
            java.util.concurrent.atomic.AtomicInteger completed = new java.util.concurrent.atomic.AtomicInteger();
            List<java.util.concurrent.Callable<Void>> counted = new ArrayList<>();
            for (java.util.concurrent.Callable<Void> read : reads) counted.add(() -> {
                read.call();
                operation.update("正在读取工作文件", completed.incrementAndGet(), reads.size());
                return null;
            });
            List<java.util.concurrent.Future<Void>> pending = readers.invokeAll(counted);
            operation.check();
            for (java.util.concurrent.Future<Void> read : pending) read.get();
        } finally { readers.shutdownNow(); }
        operation.update("目录扫描完成", result.length(), result.length());
        return result;
    }
    private void walk(Uri directory, String prefix, JSONArray result, int depth, List<java.util.concurrent.Callable<Void>> reads) throws Exception {
        if (depth > 40 || result.length() > 30000) throw new IOException("目录过深或文件过多，请选择专用工作文件夹");
        JSONArray items = children(directory);
        for (int i = 0; i < items.length(); i++) {
            operation.check();
            JSONObject item = items.getJSONObject(i); String name = item.getString("name");
            if (SKIP.contains(name) || name.startsWith(".chaos-")) continue;
            String path = prefix + name; parts(path);
            boolean isDirectory = item.getBoolean("directory");
            JSONObject file = new JSONObject().put("path", path).put("directory", isDirectory); result.put(file);
            Uri uri = DocumentsContract.buildDocumentUriUsingTree(tree, item.getString("id"));
            if (isDirectory) walk(uri, path + "/", result, depth + 1, reads);
            else if (name.toLowerCase(Locale.ROOT).endsWith(".md")) {
                reads.add(() -> {
                    try { String source = read(uri, 5 * 1024 * 1024); file.put("source", source).put("revision", sha(source)); }
                    catch (Exception error) { file.put("error", error.getMessage()); }
                    return null;
                });
            }
            operation.update("正在扫描工作目录", result.length(), -1);
        }
    }
    private void validate(JSONArray changes) throws Exception {
        if (changes.length() > 10000) throw new IOException("发布文件过多");
        Set<String> paths = new HashSet<>();
        for (int i = 0; i < changes.length(); i++) {
            JSONObject change = changes.getJSONObject(i); String path = change.getString("path"); parts(path);
            if (!paths.add(path) || path.startsWith(".atlas/") || SKIP.contains(path.split("/")[0])) throw new IOException("禁止重复或保留路径发布");
            if (!change.has("expected") || !change.has("content")) throw new IOException("发布缺少版本或正文");
            if (!change.isNull("expected") && !change.getString("expected").matches("[a-f0-9]{64}")) throw new IOException("无效文件版本");
        }
        Set<String> staging = new HashSet<>(paths);
        for (int i = 0; i < changes.length(); i++) {
            JSONObject swap = changes.getJSONObject(i).optJSONObject("swap");
            if (swap != null && (!staging.add(swap.getString("old")) || !staging.add(swap.getString("temp"))))
                throw new IOException("发布日志包含重复暂存路径");
        }
    }
    private String expected(JSONObject change) throws Exception { return change.isNull("expected") ? null : change.getString("expected"); }
    private String desired(JSONObject change) throws Exception { return change.isNull("content") ? null : sha(change.getString("content")); }
    void commit(JSONArray changes) throws Exception {
        check(); validate(changes); if (changes.length() == 0) return;
        if (find(".atlas/pending.json") != null || find(".atlas/android-swap.json") != null) throw new IOException("存在未完成发布，请重新连接");
        JSONArray journal = new JSONArray();
        Map<String, Map<String, JSONObject>> directories = new HashMap<>();
        for (int i = 0; i < changes.length(); i++) {
            JSONObject change = changes.getJSONObject(i);
            operation.update("正在检查待导入文件", i, changes.length());
            String path = change.getString("path"), prefix = path.contains("/") ? path.substring(0, path.lastIndexOf('/') + 1) : "";
            Map<String, JSONObject> siblings = directories.get(prefix);
            if (siblings == null) {
                siblings = new HashMap<>();
                Uri directory = prefix.isEmpty() ? root() : find(prefix.substring(0, prefix.length() - 1));
                if (directory != null) {
                    JSONArray listed = children(directory);
                    for (int j = 0; j < listed.length(); j++) { JSONObject file = listed.getJSONObject(j); siblings.put(file.getString("name"), file); }
                }
                directories.put(prefix, siblings);
            }
            JSONObject file = siblings.get(path.substring(prefix.length()));
            if (file != null && (file.getLong("flags") & DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0) throw new IOException("不支持虚拟文档");
            Uri current = file == null ? null : DocumentsContract.buildDocumentUriUsingTree(tree, file.getString("id"));
            if (!Objects.equals(expected(change), hash(current))) throw new IOException("文件已被外部修改，未开始保存：" + path);
            JSONObject swap = new JSONObject().put("path", path).put("old", prefix + ".chaos-old-" + UUID.randomUUID()).put("temp", prefix + ".chaos-new-" + UUID.randomUUID());
            journal.put(new JSONObject().put("path", path).put("expected", change.get("expected")).put("content", change.get("content")).put("swap", swap));
        }
        // The immutable batch journal already contains every recovery path. No per-file journal is needed.
        validate(journal);
        try {
            writeLog(".atlas/pending.json", new JSONObject().put("version", 2).put("changes", journal).toString());
            boundary();
            publishChanges(journal, null, true);
        }
        catch (Exception error) { poisoned = true; throw error; }
    }
    private void resume() throws Exception {
        // Preparing logs have never authorized a business-file mutation; discard only these known scratch files.
        delete(".atlas/pending.json.preparing"); delete(".atlas/android-swap.json.preparing");
        Uri journal = find(".atlas/pending.json");
        if (journal == null) {
            if (find(".atlas/android-swap.json") != null) throw new IOException("发布日志缺失，保留现场并停止写入");
            return;
        }
        Object document = new org.json.JSONTokener(read(journal, 64 * 1024 * 1024)).nextValue();
        JSONArray changes;
        if (document instanceof JSONArray) changes = (JSONArray) document;
        else if (document instanceof JSONObject && ((JSONObject) document).optInt("version") == 2) {
            changes = ((JSONObject) document).getJSONArray("changes");
            for (int i = 0; i < changes.length(); i++)
                if (changes.getJSONObject(i).optJSONObject("swap") == null) throw new IOException("发布日志缺少暂存路径");
        } else throw new IOException("发布日志版本不支持，保留现场并停止写入");
        validate(changes);
        // Check the entire batch before publishing any further file.
        JSONObject swap = find(".atlas/android-swap.json") == null ? null : new JSONObject(read(find(".atlas/android-swap.json"), 65536));
        boolean foundSwap = swap == null;
        for (int i = 0; i < changes.length(); i++) {
            JSONObject change = changes.getJSONObject(i); String path = change.getString("path");
            operation.update("正在检查未完成导入", i, changes.length());
            if (change.has("swap")) { validateSwap(change, change.getJSONObject("swap")); continue; }
            if (swap != null && path.equals(swap.getString("path"))) { foundSwap = true; validateSwap(change, swap); continue; }
            String current = hash(find(path));
            if (!Objects.equals(current, expected(change)) && !Objects.equals(current, desired(change))) throw new IOException("恢复遇到外部修改，未覆盖：" + path);
        }
        if (!foundSwap) throw new IOException("单文件日志不属于当前发布批次");
        publishChanges(changes, swap, false);
    }
    private void publishChanges(JSONArray changes, JSONObject swap, boolean prepared) throws Exception {
        boundary();
        List<java.util.concurrent.Callable<Void>> publications = new ArrayList<>();
        java.util.concurrent.atomic.AtomicInteger completed = new java.util.concurrent.atomic.AtomicInteger();
        operation.update("正在写入并恢复文件", 0, changes.length());
        for (int i = 0; i < changes.length(); i++) {
            JSONObject change = changes.getJSONObject(i); String path = change.getString("path");
            // Create shared parent directories before file workers start.
            if (prepared && !change.isNull("content")) parent(path);
            publications.add(() -> {
                JSONObject recovery = change.optJSONObject("swap");
                if (recovery == null && swap != null && path.equals(swap.getString("path"))) recovery = swap;
                if (recovery != null) publish(change, recovery, prepared);
                else if (!Objects.equals(hash(find(path)), desired(change))) {
                    String prefix = path.contains("/") ? path.substring(0, path.lastIndexOf('/') + 1) : "";
                    JSONObject next = new JSONObject().put("path", path).put("old", prefix + ".chaos-old-" + UUID.randomUUID()).put("temp", prefix + ".chaos-new-" + UUID.randomUUID());
                    writeLog(".atlas/android-swap.json", next.toString()); boundary(); publish(change, next, false);
                }
                synchronized (operation) {
                    operation.update("正在写入并恢复文件", completed.incrementAndGet(), changes.length());
                }
                return null;
            });
        }
        if (prepared && publications.size() > 1) {
            java.util.concurrent.ExecutorService writers = java.util.concurrent.Executors.newFixedThreadPool(4);
            try {
                List<java.util.concurrent.Future<Void>> pending = writers.invokeAll(publications);
                operation.check();
                for (java.util.concurrent.Future<Void> publication : pending) publication.get();
            } finally { writers.shutdownNow(); }
        } else {
            for (java.util.concurrent.Callable<Void> publication : publications) publication.call();
        }
        delete(".atlas/pending.json");
        operation.update("文件发布完成", changes.length(), changes.length());
        boundary();
    }
    private void validateSwap(JSONObject change, JSONObject swap) throws Exception {
        String path = change.getString("path"), old = swap.getString("old"), temp = swap.getString("temp");
        if (!path.equals(swap.getString("path"))) throw new IOException("单文件日志不属于当前文件");
        String prefix = path.contains("/") ? path.substring(0, path.lastIndexOf('/') + 1) : "";
        if (!old.matches(java.util.regex.Pattern.quote(prefix) + "\\.chaos-old-[a-f0-9-]{36}") || !temp.matches(java.util.regex.Pattern.quote(prefix) + "\\.chaos-new-[a-f0-9-]{36}")) throw new IOException("发布日志中的暂存路径无效");
        String current = hash(find(path)), held = hash(find(old)), staged = hash(find(temp));
        if (held != null && !Objects.equals(held, expected(change))) throw new IOException("原文件暂存内容发生变化，停止恢复");
        if (staged != null && !Objects.equals(staged, desired(change))) throw new IOException("新文件暂存内容发生变化，停止恢复");
        if (!Objects.equals(current, expected(change)) && !Objects.equals(current, desired(change)) && !(current == null && held != null)) throw new IOException("恢复遇到外部修改，文件有第三种内容：" + path);
        if (current == null && expected(change) != null && desired(change) != null && held == null) throw new IOException("原文件缺失，停止恢复：" + path);
    }
    private void publish(JSONObject change, JSONObject swap, boolean prepared) throws Exception {
        if (!prepared) validateSwap(change, swap);
        String path = change.getString("path"), old = swap.getString("old"), temp = swap.getString("temp");
        // New files have no original to move. The no-replace rename checks their target immediately before publication.
        Uri current = prepared && expected(change) == null ? null : find(path);
        String version = hash(current);
        if (prepared && !Objects.equals(version, expected(change)) && !Objects.equals(version, desired(change))) throw new IOException("发布前文件发生变化");
        Uri held = null;
        if (!Objects.equals(version, desired(change))) {
            Uri staged = prepared ? null : find(temp);
            if (!change.isNull("content") && staged == null) { staged = writeNew(temp, change.getString("content")); boundary(); }
            if (current != null) {
                if (!Objects.equals(hash(current), expected(change))) throw new IOException("发布前文件发生变化");
                held = rename(current, old); boundary();
            }
            if (!change.isNull("content")) { current = rename(staged, path); boundary(); }
            else current = null;
        }
        if (!Objects.equals(hash(current == null ? find(path) : current), desired(change))) throw new IOException("发布后版本校验失败");
        if (!prepared && held == null) held = find(old);
        if (held != null) {
            if (!Objects.equals(hash(held), expected(change))) throw new IOException("清理前原文件发生变化");
            if (!DocumentsContract.deleteDocument(context.getContentResolver(), held)) throw new IOException("原文件暂存清理失败");
        }
        if (!prepared) delete(temp);
        boundary();
        if (!change.has("swap")) delete(".atlas/android-swap.json");
        boundary();
    }
    JSONArray backups() throws Exception {
        check(); JSONArray result = new JSONArray(); Uri directory = find(".atlas/backups"); if (directory == null) return result;
        JSONArray items = children(directory); List<JSONObject> sorted = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            String name = items.getJSONObject(i).getString("name"); if (!name.matches("[a-f0-9-]{36}\\.json")) continue;
            JSONObject backup = new JSONObject(read(find(".atlas/backups/" + name), 64 * 1024 * 1024));
            sorted.add(new JSONObject().put("id", name.substring(0, 36)).put("createdAt", backup.getString("createdAt")).put("count", backup.getJSONArray("files").length()));
        }
        sorted.sort((a,b) -> b.optString("createdAt").compareTo(a.optString("createdAt")));
        for (JSONObject backup : sorted) result.put(backup); return result;
    }
    JSONObject backup(JSONArray entries) throws Exception {
        check(); JSONArray files = new JSONArray();
        for (int i = 0; i < entries.length(); i++) {
            JSONObject entry = entries.getJSONObject(i); String path = entry.getString("path"); String source = read(path);
            if (!sha(source).equals(entry.getString("revision"))) throw new IOException("备份前文件发生变化");
            files.put(new JSONObject().put("path", path).put("content", source));
        }
        String id = UUID.randomUUID().toString();
        String createdAt = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT) {{ setTimeZone(TimeZone.getTimeZone("UTC")); }}.format(new Date());
        writeNew(".atlas/backups/" + id + ".json", new JSONObject().put("version", 1).put("createdAt", createdAt).put("files", files).toString());
        JSONArray all = backups(); for (int i = 3; i < all.length(); i++) delete(".atlas/backups/" + all.getJSONObject(i).getString("id") + ".json");
        return new JSONObject().put("id", id).put("count", files.length());
    }
    JSONArray readBackup(String id) throws Exception {
        check(); if (!id.matches("[a-f0-9-]{36}")) throw new IOException("备份 ID 无效");
        JSONObject backup = new JSONObject(read(find(".atlas/backups/" + id + ".json"), 64 * 1024 * 1024));
        if (backup.getInt("version") != 1) throw new IOException("备份版本不支持"); return backup.getJSONArray("files");
    }
    Uri resource(String path) throws Exception { check(); Uri uri = find(path); if (uri == null) throw new IOException("手机目录中找不到此资料"); return uri; }
    void exportTo(Uri output) throws Exception {
        check(); if (find(".atlas/pending.json") != null) throw new IOException("先恢复未完成发布再导出");
        JSONArray files = scan();
        try (OutputStream stream = context.getContentResolver().openOutputStream(output, "wt"); ZipOutputStream zip = new ZipOutputStream(stream)) {
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.getJSONObject(i); if (file.getBoolean("directory")) continue;
                String path = file.getString("path"); zip.putNextEntry(new ZipEntry(path));
                try (InputStream input = context.getContentResolver().openInputStream(find(path))) {
                    byte[] buffer = new byte[16384]; int count; while ((count = input.read(buffer)) >= 0) zip.write(buffer, 0, count);
                }
                zip.closeEntry();
            }
        }
    }
    @Override public void close() throws Exception {
        try { if (lock.isValid() && !operation.isStopped()) { Uri owner = find(".atlas/android-owner.json"); if (owner != null && device.equals(new JSONObject(read(owner, 65536)).getString("device"))) delete(".atlas/android-owner.json"); } }
        finally { lock.release(); lockChannel.close(); }
    }
}
