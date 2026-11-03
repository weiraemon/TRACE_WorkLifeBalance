package com.chaos.workbench;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.provider.DocumentsContract;
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

@CapacitorPlugin(name = "ChaosFiles")
public class ChaosFilesPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private DocumentStore store;
    private boolean picking;
    private SharedPreferences config() { return getContext().getSharedPreferences("chaos-local", 0); }
    private String device() {
        String id = config().getString("device", null);
        if (id == null) { id = UUID.randomUUID().toString(); config().edit().putString("device", id).commit(); }
        return id;
    }
    private void resolve(PluginCall call, Object value) { JSObject response = new JSObject(); response.put("value", value == null ? JSONObject.NULL : value); call.resolve(response); }
    private void fail(PluginCall call, Exception error) { call.reject(error.getMessage() == null ? "文件操作失败，当前输入已保留" : error.getMessage()); }
    private void open(Uri uri) throws Exception {
        if (store != null && store.tree.equals(uri)) return;
        DocumentStore next = new DocumentStore(getContext(), uri, device());
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
        worker.execute(() -> {
            try {
                JSONObject input = call.getObject("input", new JSObject());
                if (method.equals("session")) {
                    if (store == null) {
                        String saved = config().getString("tree", "");
                        if (!saved.isEmpty()) open(Uri.parse(saved));
                    }
                    resolve(call, store == null ? null : directory()); return;
                }
                if (method.equals("background")) { getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true)); resolve(call, null); return; }
                if (store == null || !store.session.equals(input.optString("vaultId"))) throw new Exception("工作目录会话已失效，请重新连接");
                switch (method) {
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
            } catch (Exception error) { fail(call, error); }
        });
    }
    @ActivityCallback private void directoryPicked(PluginCall call, ActivityResult result) {
        picking = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.reject("已取消选择，原目录保持不变"); return; }
        Uri uri = result.getData().getData();
        int flags = result.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        worker.execute(() -> {
            try {
                getContext().getContentResolver().takePersistableUriPermission(uri, flags);
                // Reconnect is also the explicit recovery entry after an interrupted publication.
                if (store != null && store.tree.equals(uri)) { store.close(); store = null; }
                open(uri); resolve(call, directory());
            } catch (Exception error) { fail(call, error); }
        });
    }
    @ActivityCallback private void exportPicked(PluginCall call, ActivityResult result) {
        picking = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) { call.reject("已取消导出"); return; }
        Uri uri = result.getData().getData();
        worker.execute(() -> { try { store.exportTo(uri); resolve(call, null); } catch (Exception error) { fail(call, error); } });
    }
    @Override protected void handleOnDestroy() {
        worker.execute(() -> { try { if (store != null) store.close(); } catch (Exception ignored) {} }); worker.shutdown();
    }
}
