package app.centauricontrol;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Lets the app read the bed-levelling data off an OpenCentauri-patched printer.
 * Only the fixed read-only queries in OcShell are possible; no command text
 * from the web page ever reaches the printer's root shell.
 */
@CapacitorPlugin(name = "PrinterShell")
public class PrinterShellPlugin extends Plugin {

    @PluginMethod
    public void read(PluginCall call) {
        final String host = call.getString("host");
        final String query = call.getString("query");
        final String path = call.getString("path");
        final int logMb = call.getInt("logMb", 4);
        // Network off the main thread.
        new Thread(() -> {
            try {
                JSObject ret = new JSObject();
                ret.put("text", OcShell.run(host, query, path, logMb, 60000));
                call.resolve(ret);
            } catch (Throwable e) { // anything, so the page never waits forever
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }).start();
    }
}
