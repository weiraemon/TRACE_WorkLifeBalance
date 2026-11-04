package com.chaos.workbench;

import android.os.CancellationSignal;
import android.os.SystemClock;
import java.io.IOException;
import java.util.function.Consumer;
import org.json.JSONObject;

/** Per-call cancellation and progress. No work content or file paths are reported. */
final class NativeOperation {
    final CancellationSignal signal = new CancellationSignal();
    final String taskId;
    final boolean storage;
    private final Consumer<JSONObject> listener;
    private volatile String stopped;
    private final java.util.Set<Runnable> activeIo = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final ThreadLocal<Runnable> threadIo = new ThreadLocal<>();
    private volatile long lastActivity = SystemClock.elapsedRealtime();
    private long lastUpdate;
    private String lastPhase = "";

    NativeOperation(String taskId, Consumer<JSONObject> listener) {
        this(taskId, listener, true);
    }
    NativeOperation(String taskId, Consumer<JSONObject> listener, boolean storage) {
        this.taskId = taskId;
        this.listener = listener;
        this.storage = storage;
    }
    void onCancel(Runnable action) {
        Runnable previous = threadIo.get();
        if (previous != null) activeIo.remove(previous);
        if (action == null) threadIo.remove();
        else { threadIo.set(action); activeIo.add(action); }
        if (stopped != null && action != null) action.run();
    }
    void cancel(String reason) {
        stop(reason);
        signal.cancel();
        for (Runnable action : activeIo) action.run();
    }
    void stop(String reason) { stopped = reason; }
    boolean isStopped() { return stopped != null; }
    boolean idleFor(long milliseconds) { return SystemClock.elapsedRealtime() - lastActivity >= milliseconds; }
    void check() throws IOException {
        if (stopped != null) throw new IOException(stopped);
    }
    synchronized void update(String phase, int completed, int total) throws Exception {
        check();
        long now = SystemClock.elapsedRealtime();
        lastActivity = now;
        if (phase.equals(lastPhase) && now - lastUpdate < 150 && completed != total) return;
        lastUpdate = now;
        lastPhase = phase;
        JSONObject event = new JSONObject().put("taskId", taskId).put("phase", phase);
        if (completed >= 0) event.put("completed", completed);
        if (total > 0) event.put("total", total);
        listener.accept(event);
    }
}
