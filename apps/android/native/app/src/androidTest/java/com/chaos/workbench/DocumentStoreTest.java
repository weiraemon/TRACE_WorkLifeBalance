package com.chaos.workbench;

import android.content.Context;
import android.net.Uri;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Before;
import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.OutputStream;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import static org.junit.Assert.*;

/** Real SAF tests. Run only against the explicitly selected synthetic emulator directory. */
public class DocumentStoreTest {
    @Test public void exchangeFilesAreBoundedAndStrictUtf8() throws Exception {
        try { ChaosFilesPlugin.wifiRequest("http://8.8.8.8:4317/chaos-exchange/00000000-0000-0000-0000-000000000000", "{}"); fail("应拒绝公网"); }
        catch (Exception expected) { assertTrue(expected.getMessage().contains("局域网")); }
        try { ChaosFilesPlugin.wifiRequest("http://127.0.0.1:4317/api/session", "{}"); fail("应拒绝非交换接口"); }
        catch (Exception expected) { assertTrue(expected.getMessage().contains("局域网")); }
        assertEquals("{\"text\":\"正文\"}", ChaosFilesPlugin.readExchange(new ByteArrayInputStream("{\"text\":\"正文\"}".getBytes(StandardCharsets.UTF_8))));
        try { ChaosFilesPlugin.readExchange(new ByteArrayInputStream(new byte[] {(byte)0xc3, (byte)0x28})); fail("应拒绝非法 UTF-8"); }
        catch (java.nio.charset.CharacterCodingException expected) { }
        try { ChaosFilesPlugin.readExchange(new ByteArrayInputStream(new byte[524289])); fail("应拒绝超大文件"); }
        catch (Exception expected) { assertTrue(expected.getMessage().contains("512")); }
    }
    private Context context;
    private Uri tree;
    private String device;
    @Before public void setup() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String uri = context.getSharedPreferences("chaos-local", 0).getString("tree", "");
        assertTrue("先在模拟器选择 Documents/CHAOS-Android-Test；测试拒绝用户目录", Uri.decode(uri).endsWith("/CHAOS-Android-Test"));
        tree = Uri.parse(uri);
        device = context.getSharedPreferences("chaos-local", 0).getString("device", "");
        DocumentStore.interruptAfter = -1;
        // A previous interrupted test may have left its deliberately invalid UTF-8 fixture.
        try (DocumentStore cleanup = new DocumentStore(context, tree, device)) {
            JSONArray files = cleanup.scan();
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.getJSONObject(i);
                if (file.has("error") && file.getString("path").matches("instrumentation/[a-f0-9-]{36}\\.md"))
                    android.provider.DocumentsContract.deleteDocument(context.getContentResolver(), cleanup.resource(file.getString("path")));
            }
        }
    }
    private JSONObject change(String path, String expected, String content) throws Exception {
        return new JSONObject().put("path", path).put("expected", expected == null ? JSONObject.NULL : expected).put("content", content == null ? JSONObject.NULL : content);
    }
    @Test public void interruptedBatchRecoversAtEveryPublicationBoundary() throws Exception {
        for (int boundary = 1; boundary <= 15; boundary++) {
            String prefix = "instrumentation/" + UUID.randomUUID() + "/";
            DocumentStore store = new DocumentStore(context, tree, device);
            store.commit(new JSONArray().put(change(prefix + "a.md", null, "原文A")).put(change(prefix + "b.md", null, "原文B")));
            DocumentStore.interruptAfter = boundary;
            try { store.commit(new JSONArray().put(change(prefix + "a.md", DocumentStore.sha("原文A"), "新文A")).put(change(prefix + "b.md", DocumentStore.sha("原文B"), "新文B"))); }
            catch (Exception expected) { assertTrue(expected.getMessage(), expected.getMessage().contains("模拟发布中断")); }
            finally { DocumentStore.interruptAfter = -1; store.close(); }
            try (DocumentStore recovered = new DocumentStore(context, tree, device)) {
                assertEquals("新文A", recovered.read(prefix + "a.md"));
                assertEquals("新文B", recovered.read(prefix + "b.md"));
            }
        }
    }
    @Test public void rejectsExternalEditsAndPathTraversal() throws Exception {
        String path = "instrumentation/" + UUID.randomUUID() + ".md";
        try (DocumentStore store = new DocumentStore(context, tree, device)) {
            store.commit(new JSONArray().put(change(path, null, "原文")));
            try (OutputStream output = context.getContentResolver().openOutputStream(store.resource(path), "wt")) { output.write("外部编辑".getBytes(StandardCharsets.UTF_8)); }
            try { store.commit(new JSONArray().put(change(path, DocumentStore.sha("原文"), "覆盖"))); fail("应拒绝过期版本"); }
            catch (Exception expected) { assertTrue(expected.getMessage().contains("外部修改")); }
            assertEquals("外部编辑", store.read(path));
            try { store.commit(new JSONArray().put(change("../outside.md", null, "不应写入"))); fail("应拒绝路径越界"); }
            catch (Exception expected) { assertTrue(expected.getMessage().contains("路径")); }
        }
    }
    @Test public void strictUtf8AndExclusiveDirectoryLock() throws Exception {
        String path = "instrumentation/" + UUID.randomUUID() + ".md";
        try (DocumentStore store = new DocumentStore(context, tree, device)) {
            store.commit(new JSONArray().put(change(path, null, "placeholder")));
            assertNull("资料目录没有单文件指纹", store.fingerprint("instrumentation"));
            try (OutputStream output = context.getContentResolver().openOutputStream(store.resource(path), "wt")) { output.write(new byte[]{(byte)0xff, (byte)0xfe}); }
            try { store.read(path); fail("应拒绝非法 UTF-8"); } catch (java.nio.charset.CharacterCodingException expected) {}
            try { new DocumentStore(context, tree, device); fail("应拒绝第二个写入者"); } catch (Exception expected) { assertTrue(expected.getMessage().contains("运行时") || expected.getMessage().contains("占用")); }
            android.provider.DocumentsContract.deleteDocument(context.getContentResolver(), store.resource(path));
        }
    }
    @Test public void pendingBatchConflictDoesNotPublishOtherFiles() throws Exception {
        String prefix = "instrumentation/" + UUID.randomUUID() + "/";
        DocumentStore store = new DocumentStore(context, tree, device);
        store.commit(new JSONArray().put(change(prefix + "a.md", null, "原文A")).put(change(prefix + "b.md", null, "原文B")));
        Uri a = store.resource(prefix + "a.md"), b = store.resource(prefix + "b.md");
        DocumentStore.interruptAfter = 1;
        try { store.commit(new JSONArray().put(change(prefix + "a.md", DocumentStore.sha("原文A"), "新文A")).put(change(prefix + "b.md", DocumentStore.sha("原文B"), "新文B"))); }
        catch (Exception expected) { assertTrue(expected.getMessage().contains("模拟发布中断")); }
        finally { DocumentStore.interruptAfter = -1; store.close(); }
        try (OutputStream output = context.getContentResolver().openOutputStream(b, "wt")) { output.write("外部第三种内容".getBytes(StandardCharsets.UTF_8)); }
        try { new DocumentStore(context, tree, device); fail("应停止恢复"); }
        catch (Exception expected) { assertTrue(expected.getMessage().contains("外部修改")); }
        try (java.io.InputStream input = context.getContentResolver().openInputStream(a)) {
            byte[] bytes = new byte[1024]; int count = input.read(bytes); assertEquals("原文A", new String(bytes, 0, count, StandardCharsets.UTF_8));
        }
        try (OutputStream output = context.getContentResolver().openOutputStream(b, "wt")) { output.write("原文B".getBytes(StandardCharsets.UTF_8)); }
        try (DocumentStore recovered = new DocumentStore(context, tree, device)) { assertEquals("新文A", recovered.read(prefix + "a.md")); assertEquals("新文B", recovered.read(prefix + "b.md")); }
    }
}
