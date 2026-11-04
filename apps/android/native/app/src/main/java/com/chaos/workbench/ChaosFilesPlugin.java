package com.chaos.workbench;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.Settings;
import androidx.appcompat.app.AlertDialog;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.charset.CodingErrorAction;
import java.net.HttpURLConnection;
import java.net.URL;

@CapacitorPlugin(name = "ChaosFiles")
public class ChaosFilesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService cancellations = Executors.newFixedThreadPool(2);
    private final ConcurrentHashMap<PluginCall, NativeOperation> operations = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<PluginCall, AtomicBoolean> settled = new ConcurrentHashMap<>();
    private volatile DocumentStore store;
    private boolean picking;
    private SharedPreferences config() { return getContext().getSharedPreferences("chaos-local", 0); }
    private String device() {
        String id = config().getString("device", null);
        if (id == null) {
            String androidId = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
            id = androidId == null ? UUID.randomUUID().toString() : UUID.nameUUIDFromBytes((getContext().getPackageName() + androidId).getBytes(StandardCharsets.UTF_8)).toString();
            config().edit().putString("device", id).commit();
        }
        return id;
    }
    private boolean finish(PluginCall call) { AtomicBoolean flag = settled.get(call); return flag == null || flag.compareAndSet(false, true); }
    private void resolve(PluginCall call, Object value) { if (!finish(call)) return; JSObject response = new JSObject(); response.put("value", value == null ? JSONObject.NULL : value); call.resolve(response); }
    private void fail(PluginCall call, Exception error) { if (finish(call)) call.reject(error.getMessage() == null ? "文件操作失败，当前输入已保留" : error.getMessage()); }
    private interface Work { void run(NativeOperation operation) throws Exception; }
    private void cancel(PluginCall call, NativeOperation operation, String reason) {
        operation.stop(reason);
        fail(call, new Exception(reason));
        cancellations.execute(() -> operation.cancel(reason));
    }
    private void submit(PluginCall call, ExecutorService executor, Work action) {
        String taskId = call.getObject("input", new JSObject()).optString("_taskId", "");
        NativeOperation operation = new NativeOperation(taskId, event -> {
            try { notifyListeners("operationProgress", JSObject.fromJSONObject(event)); }
            catch (org.json.JSONException ignored) { }
        }, executor == worker);
        AtomicBoolean completion = new AtomicBoolean();
        operations.put(call, operation); settled.put(call, completion);
        var timeout = deadlines.scheduleAtFixedRate(() -> {
            if (operations.get(call) == operation && operation.idleFor(120000)) cancel(call, operation, "操作长时间没有进度，已超时。请检查电脑连接或重新选择目录，未完成导入会在重新连接时继续恢复。");
        }, 5, 5, java.util.concurrent.TimeUnit.SECONDS);
        executor.execute(() -> {
            try { operation.check(); if (store != null && executor == worker) store.operation(operation); action.run(operation); }
            catch (Exception error) {
                try { operation.check(); } catch (Exception cancelled) { error = cancelled; }
                fail(call, error);
            } finally { timeout.cancel(false); operations.remove(call, operation); settled.remove(call, completion); }
        });
    }
    private void open(Uri uri, boolean reclaim, NativeOperation operation) throws Exception {
        if (store != null && store.tree.equals(uri)) return;
        DocumentStore next = new DocumentStore(getContext(), uri, device(), reclaim, operation);
        DocumentStore previous = store; store = next; if (previous != null) previous.close();
    }
    private JSONObject directory() throws Exception { return new JSONObject().put("root", store.tree.toString()).put("vaultId", store.session); }
    @PluginMethod public void request(PluginCall call) {
        getActivity().runOnUiThread(() -> dispatch(call));
    }
    private void dispatch(PluginCall call) {
        String method = call.getString("method", "");
        String url = getBridge().getWebView().getUrl();
        if (url == null || !url.startsWith("https://localhost/")) { call.reject("拒绝来自非本地应用页面的调用"); return; }
        if (method.equals("cancelOperation")) {
            String id = call.getObject("input", new JSObject()).optString("taskId", "");
            operations.forEach((pending, operation) -> { if (!id.isEmpty() && id.equals(operation.taskId)) {
                cancel(pending, operation, "读取已停止。可以重试，目录若有未完成导入请重新选择以恢复。");
            } });
            resolve(call, null); return;
        }
        if (operations.values().stream().anyMatch(operation -> operation.isStopped() && operation.storage == !method.equals("wifiRequest"))) {
            call.reject("上次目录或连接操作正在停止，请稍后重试。仍无法恢复时，请强制停止应用后重新打开。"); return;
        }
        if (method.equals("scanPairing")) {
            if (picking) { call.reject("系统选择器正在打开"); return; }
            picking = true;
            com.google.zxing.integration.android.IntentIntegrator scanner = new com.google.zxing.integration.android.IntentIntegrator(getActivity());
            scanner.setDesiredBarcodeFormats(com.google.zxing.integration.android.IntentIntegrator.QR_CODE);
            scanner.setPrompt("扫描电脑上的 CHAOS 配对二维码"); scanner.setBeepEnabled(false); scanner.setOrientationLocked(false);
            startActivityForResult(call, scanner.createScanIntent(), "pairingScanned"); return;
        }
        if (method.equals("readExchange") || method.equals("saveExchange")) {
            if (picking) { call.reject("系统选择器正在打开"); return; }
            Intent intent;
            if (method.equals("readExchange")) {
                intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE);
            } else {
                JSONObject input = call.getObject("input", new JSObject());
                String filename = input.optString("filename", "");
                if (!filename.matches("CHAOS-(changes|receipt)-[a-fA-F0-9-]+\\.json") ||
                    input.optString("text").getBytes(StandardCharsets.UTF_8).length > 524288) {
                    call.reject("非法交换文件名或文件超过 512 KiB"); return;
                }
                intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, filename);
            }
            picking = true;
            startActivityForResult(call, intent, method.equals("readExchange") ? "exchangeReadPicked" : "exchangeSavePicked");
            return;
        }
        if (method.equals("chooseDirectory") || method.equals("export")) {
            if (picking) { call.reject("系统选择器正在打开"); return; }
            picking = true;
            Intent intent;
            if (method.equals("chooseDirectory")) {
                intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:Documents"));
                startActivityForResult(call, intent, "directoryPicked");
            } else {
                if (store == null) { picking = false; call.reject("请先连接工作目录"); return; }
                intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/zip").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, "CHAOS-workspace.zip");
                startActivityForResult(call, intent, "exportPicked");
            }
            return;
        }
        submit(call, method.equals("wifiRequest") ? network : worker, operation -> {
                JSONObject input = call.getObject("input", new JSObject());
                if (method.equals("session")) {
                    if (store == null) {
                        String saved = config().getString("tree", "");
                        if (!saved.isEmpty()) open(Uri.parse(saved), false, operation);
                    }
                    resolve(call, store == null ? null : directory()); return;
                }
                if (method.equals("background")) { getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true)); resolve(call, null); return; }
                if (store == null || !store.session.equals(input.optString("vaultId"))) throw new Exception("工作目录会话已失效，请重新连接");
                switch (method) {
                    case "wifiRequest": resolve(call, wifiRequest(input.getString("url"), input.getString("body"), operation)); break;
                    case "remember": config().edit().putString("tree", store.tree.toString()).commit(); resolve(call, null); break;
                    case "scan": resolve(call, store.scan()); break;
                    case "read": resolve(call, store.read(input.getString("path"))); break;
                    case "fingerprint": resolve(call, store.fingerprint(input.getString("path"))); break;
                    case "commit": store.commit(input.getJSONArray("changes")); resolve(call, null); break;
                    case "backups": resolve(call, store.backups()); break;
                    case "backup": resolve(call, store.backup(input.getJSONArray("entries"))); break;
                    case "readBackup": resolve(call, store.readBackup(input.getString("id"))); break;
                    case "open": {
                        Uri target;
                        if (input.getString("location").equals("url")) {
                            target = Uri.parse(input.getString("target"));
                            if (!"http".equals(target.getScheme()) && !"https".equals(target.getScheme())) throw new Exception("仅允许 http(s) 网页资源");
                        } else {
                            String path = input.getString("target");
                            target = store.resource(path);
                            boolean directory = DocumentsContract.Document.MIME_TYPE_DIR.equals(getContext().getContentResolver().getType(target));
                            if (!directory && !path.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(md|txt|pdf|png|jpg|jpeg|gif|webp|docx?|xlsx?|pptx?|csv|zip)$")) throw new Exception("不支持打开此类文件");
                        }
                        Intent intent = new Intent(Intent.ACTION_VIEW).setData(target).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().runOnUiThread(() -> { try { getActivity().startActivity(intent); resolve(call, null); } catch (Exception error) { fail(call, new Exception("手机没有可打开此资料的应用")); } });
                        break;
                    }
                    default: throw new Exception("不支持的原生操作");
                }
        });
    }
    @ActivityCallback private void directoryPicked(PluginCall call, ActivityResult result) {
        picking = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("已取消选择，原目录保持不变"); return; }
        Uri uri = result.getData().getData();
        int flags = result.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        submit(call, worker, operation -> {
                getContext().getContentResolver().takePersistableUriPermission(uri, flags);
                // Reconnect is also the explicit recovery entry after an interrupted publication.
                if (store != null && store.tree.equals(uri)) { store.close(); store = null; }
                try { open(uri, false, operation); resolve(call, directory()); }
                catch (DocumentStore.OwnershipChanged error) {
                    operation.update("等待确认重新授权旧目录", -1, -1);
                    getActivity().runOnUiThread(() -> new AlertDialog.Builder(getActivity())
                        .setTitle("重新授权原工作目录")
                        .setMessage("目录保留了旧安装或其他设备的授权标记。请确认相关应用已经关闭，接管后将检查并恢复未完成导入。")
                        .setNegativeButton("取消", (dialog, which) -> call.reject("已取消接管"))
                        .setOnCancelListener(dialog -> call.reject("已取消接管"))
                        .setPositiveButton("接管并恢复", (dialog, which) -> submit(call, worker, next -> { open(uri, true, next); resolve(call, directory()); }))
                        .show());
                }
        });
    }
    @ActivityCallback private void exportPicked(PluginCall call, ActivityResult result) {
        picking = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("已取消导出"); return; }
        Uri uri = result.getData().getData();
        submit(call, worker, operation -> { store.exportTo(uri); resolve(call, null); });
    }
    static String readExchange(InputStream stream) throws Exception {
        if (stream == null) throw new Exception("无法读取交换文件");
        try (InputStream input = stream; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 524288) throw new Exception("交换文件超过 512 KiB");
                output.write(buffer, 0, count);
            }
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString();
        }
    }
    static String wifiRequest(String address, String body) throws Exception {
        return wifiRequest(address, body, new NativeOperation("", event -> {}));
    }
    static String wifiRequest(String address, String body, NativeOperation operation) throws Exception {
        URL url = new URL(address);
        String host = url.getHost();
        if (!host.matches("[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+")) throw new Exception("只允许局域网 IPv4 地址");
        String[] parts = host.split("\\."); int[] ip = new int[4];
        for (int i = 0; i < 4; i++) { ip[i] = Integer.parseInt(parts[i]); if (ip[i] > 255) throw new Exception("非法地址"); }
        boolean local = ip[0] == 10 || ip[0] == 127 || (ip[0] == 192 && ip[1] == 168) || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31);
        if (!local || !url.getProtocol().equals("http") || url.getPort() < 1024 || url.getPort() > 65535 ||
            url.getUserInfo() != null || url.getQuery() != null || url.getRef() != null ||
            !url.getPath().matches("/chaos-exchange/[a-f0-9-]{36}")) throw new Exception("非法 CHAOS 局域网地址");
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        if (payload.length > 1600000) throw new Exception("Wi-Fi 交换数据过大");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        operation.onCancel(connection::disconnect);
        try {
            operation.update("正在连接电脑", -1, -1);
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(5000); connection.setReadTimeout(30000);
            connection.setRequestMethod("POST"); connection.setDoOutput(true); connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(payload); }
            operation.update("请求已发送，正在等待电脑整理数据", -1, -1);
            if (connection.getResponseCode() != 200) throw new Exception("配对已过期或请求无效，请重新连接");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int count;
                int total = connection.getContentLength();
                while ((count = input.read(buffer)) != -1) {
                    operation.update("正在接收电脑数据（字节）", output.size() + count, total);
                    if (output.size() + count > 1600000) throw new Exception("Wi-Fi 响应过大");
                    output.write(buffer, 0, count);
                }
                return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(output.toByteArray())).toString();
            }
        } catch (java.net.SocketTimeoutException | java.net.ConnectException error) {
            throw new java.io.IOException("连接电脑超时，请检查同一 Wi-Fi、电脑连接是否开启，以及专用网络防火墙权限。", error);
        } finally { operation.onCancel(null); connection.disconnect(); }
    }
    @ActivityCallback private void exchangeReadPicked(PluginCall call, ActivityResult result) {
        picking = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("已取消读取"); return; }
        Uri uri = result.getData().getData();
        submit(call, worker, operation -> { operation.update("正在读取交换文件", -1, -1); resolve(call, readExchange(getContext().getContentResolver().openInputStream(uri))); });
    }
    @ActivityCallback private void exchangeSavePicked(PluginCall call, ActivityResult result) {
        picking = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("已取消保存"); return; }
        Uri uri = result.getData().getData();
        submit(call, worker, operation -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new Exception("无法保存交换文件");
                output.write(call.getObject("input", new JSObject()).getString("text").getBytes(StandardCharsets.UTF_8));
                output.flush(); resolve(call, null);
            } catch (Exception error) { fail(call, error); }
        });
    }
    @ActivityCallback private void pairingScanned(PluginCall call, ActivityResult result) {
        picking = false; if (call == null) return;
        String value = result.getData() == null ? null : result.getData().getStringExtra("SCAN_RESULT");
        if (result.getResultCode() != Activity.RESULT_OK || value == null) { call.reject("已取消扫码"); return; }
        resolve(call, value);
    }
    @Override protected void handleOnDestroy() {
        operations.forEach((call, operation) -> cancel(call, operation, "应用已关闭，请重新打开以恢复目录"));
        network.shutdownNow(); deadlines.shutdownNow();
        cancellations.shutdown();
        worker.execute(() -> { try { if (store != null) store.close(); } catch (Exception ignored) {} }); worker.shutdown();
    }
}
