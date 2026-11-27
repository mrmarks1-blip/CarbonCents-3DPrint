package app.centauricontrol;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.regex.Pattern;

/**
 * Read-only access to the OpenCentauri root shell (TCP 4567, root, no login).
 *
 * That shell runs anything as root, so this class never takes a command from
 * the caller. It builds one of a few fixed, read-only commands itself; the only
 * caller input is the printer address and, for one query, a file path that must
 * match a strict pattern. Plain Java, no Android types, so it can be tested on
 * a desktop JVM.
 */
public final class OcShell {
    public static final int PORT = 4567;
    private static final int MAX_BYTES = 6_000_000;
    private static final Pattern HOST = Pattern.compile("^[A-Za-z0-9.\\-:\\[\\]]{1,253}$");
    /** Config-like files under the folders that hold the printer's settings. No "..", no spaces, no quotes. */
    private static final Pattern MESH_PATH = Pattern.compile("^/(board-resource|app|etc)(/[A-Za-z0-9_.\\-]+){1,4}\\.(cfg|conf|json|ini)$");

    private OcShell() {}

    /** The fixed command for a query, or null when the query is not allowed. */
    public static String command(String query, String path, int logMb) {
        int bytes = Math.max(1, Math.min(logMb, 4)) * 1_000_000; // the printer has only a few MB free
        switch (query) {
            case "clock":
                return "cat /proc/uptime; date +%s";
            case "probe-log":
                return "tail -c " + bytes + " /board-resource/log1 2>/dev/null | grep -E '\\[probe\\]|exceed tolerance'; "
                    + "tail -c " + bytes + " /board-resource/log2 2>/dev/null | grep -E '\\[probe\\]|exceed tolerance'";
            case "mesh-files":
                return "for f in $(find /board-resource /app /etc -maxdepth 3 -type f -size -100k "
                    + "\\( -name '*.cfg' -o -name '*.conf' -o -name '*.json' -o -name '*.ini' \\) 2>/dev/null); "
                    + "do grep -qi 'mesh' \"$f\" 2>/dev/null && echo \"$f\"; done";
            case "mesh-file":
                if (path == null || path.contains("..") || !MESH_PATH.matcher(path).matches()) return null;
                return "head -c 200000 '" + path + "'";
            default:
                return null;
        }
    }

    public static boolean validHost(String host) {
        return host != null && HOST.matcher(host).matches();
    }

    /** Run an allowed query and return its output (text between the markers). */
    public static String run(String host, String query, String path, int logMb, int timeoutMs) throws Exception {
        if (!validHost(host)) throw new IllegalArgumentException("Bad printer address.");
        String cmd = command(query, path, logMb);
        if (cmd == null) throw new IllegalArgumentException("Query not allowed: " + query);
        byte[] rnd = new byte[6];
        new SecureRandom().nextBytes(rnd);
        StringBuilder tag = new StringBuilder();
        for (byte b : rnd) tag.append(String.format("%02x", b));
        String start = "S" + tag + "S", end = "E" + tag + "E";
        // Markers are split in the echo so the echoed command line never matches.
        // One line only: the shell prints a prompt per line, which would land in the output.
        String wire = "echo S" + tag + "''S; " + cmd + " ; echo E" + tag + "''E\n";

        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, PORT), 6000);
            s.setSoTimeout(timeoutMs);
            OutputStream out = s.getOutputStream();
            out.write(wire.getBytes(StandardCharsets.UTF_8));
            out.flush();
            InputStream in = s.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[65536];
            byte[] endBytes = end.getBytes(StandardCharsets.UTF_8);
            byte[] tail = new byte[0]; // last bytes seen, so a marker split across reads is still found
            long deadline = System.currentTimeMillis() + timeoutMs;
            boolean complete = false;
            try {
                while (buf.size() < MAX_BYTES) {
                    long left = deadline - System.currentTimeMillis();
                    if (left <= 0) break;
                    s.setSoTimeout((int) Math.max(1, left)); // the whole read, not each chunk, is bounded
                    int n = in.read(chunk);
                    if (n < 0) break;
                    buf.write(chunk, 0, n);
                    byte[] window = new byte[tail.length + n];
                    System.arraycopy(tail, 0, window, 0, tail.length);
                    System.arraycopy(chunk, 0, window, tail.length, n);
                    if (contains(window, endBytes, 0)) {
                        complete = true;
                        break;
                    }
                    int keep = Math.min(window.length, endBytes.length);
                    tail = new byte[keep];
                    System.arraycopy(window, window.length - keep, tail, 0, keep);
                }
            } catch (SocketTimeoutException e) {
                // fall through with what arrived
            }
            try {
                out.write("exit\n".getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) {
                // already closed
            }
            String text = new String(buf.toByteArray(), StandardCharsets.UTF_8);
            int a = text.indexOf(start);
            if (a < 0) throw new Exception("The printer's shell did not answer as expected. Is this OpenCentauri-patched firmware?");
            text = text.substring(a + start.length());
            int b = text.indexOf(end);
            if (b >= 0) return text.substring(0, b).replaceFirst("^[\\r\\n]+", "");
            if (buf.size() >= MAX_BYTES) {
                // Too much to carry: keep what arrived, minus a possibly cut last line. The newest lines are
                // at the end of each log, so the caller should read less (logMb) for the very latest.
                int nl = text.lastIndexOf('\n');
                return (nl > 0 ? text.substring(0, nl) : text).replaceFirst("^[\\r\\n]+", "");
            }
            if (!complete)
                throw new Exception("The printer's shell did not finish in time. It may still be busy with the last request: wait a minute and try again.");
            throw new Exception("The printer's shell stopped answering before the end of the reply.");
        }
    }

    private static boolean contains(byte[] hay, byte[] needle, int from) {
        outer:
        for (int i = from; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
            return true;
        }
        return false;
    }
}
