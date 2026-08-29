using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

internal static class Program
{
    private const string NodeVersion = "24.19.0";
    private const int MinimumNodeMajor = 24;
    private const string DistRoot = "https://nodejs.org/dist/v" + NodeVersion + "/";

    private static async Task<int> Main(string[] args)
    {
        try
        {
            var root = PackageRoot();
            var app = Path.Combine(root, "app");
            var host = Path.Combine(root, "host");
            var script = Path.Combine(app, "scripts", "launch.mjs");
            if (!File.Exists(script))
            {
                throw new InvalidOperationException(
                    "Studio launch script is missing. Extract the full release folder, including the app directory.");
            }
            if (!File.Exists(Path.Combine(host, "build", "bin", "runtime", "launch.mjs")))
            {
                throw new InvalidOperationException(
                    "Lean ThreeBrowser host is missing. Extract the full release folder, including the host directory.");
            }

            var node = await ResolveNode(root);
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            var projects = Path.Combine(localAppData, "ThreeBrowserStudio", "projects");

            var start = new ProcessStartInfo();
            start.FileName = node;
            start.Arguments = Quote(script) + FormatArgs(args);
            start.WorkingDirectory = app;
            start.UseShellExecute = false;
            start.EnvironmentVariables["THREE_STUDIO_ROOT"] = app;
            start.EnvironmentVariables["THREEBROWSER_RUNTIME_ROOT"] = host;
            start.EnvironmentVariables["THREEBROWSER_RUNTIME_NODE_MODULES"] = Path.Combine(host, "node_modules");
            start.EnvironmentVariables["THREE_STUDIO_PROJECTS"] = projects;

            Console.WriteLine("[ThreeBrowser Studio] Starting native WebGPU Studio...");
            using (var child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("Node.js did not start.");
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[ThreeBrowser Studio] " + error.Message);
            if (!Console.IsInputRedirected)
            {
                Console.WriteLine("Press Enter to close.");
                Console.ReadLine();
            }
            return 1;
        }
    }

    private static async Task<string> ResolveNode(string packageRoot)
    {
        var configured = Environment.GetEnvironmentVariable("THREE_STUDIO_NODE");
        if (!string.IsNullOrEmpty(configured) && IsUsableNode(configured)) return Path.GetFullPath(configured);

        var bundled = Path.Combine(packageRoot, "node", "node.exe");
        if (IsUsableNode(bundled)) return bundled;

        var onPath = FindNodeOnPath();
        if (onPath != null) return onPath;

        var cached = CachedNodePath();
        if (IsUsableNode(cached)) return cached;

        if (!OfferDownload())
        {
            throw new InvalidOperationException(
                "Node.js " + MinimumNodeMajor + " or newer is required. Install it from https://nodejs.org/ or set THREE_STUDIO_NODE.");
        }
        await DownloadOfficialNode(cached);
        if (!IsUsableNode(cached))
        {
            throw new InvalidOperationException("Downloaded Node.js is not version " + MinimumNodeMajor + " or newer.");
        }
        return cached;
    }

    private static bool OfferDownload()
    {
        var auto = Environment.GetEnvironmentVariable("THREE_STUDIO_DOWNLOAD_NODE");
        if (!string.IsNullOrEmpty(auto) && IsYes(auto)) return true;
        if (Console.IsInputRedirected)
        {
            throw new InvalidOperationException(
                "Node.js " + MinimumNodeMajor + " was not found. Install it from https://nodejs.org/, set THREE_STUDIO_NODE, or set THREE_STUDIO_DOWNLOAD_NODE=1.");
        }
        Console.WriteLine("[ThreeBrowser Studio] Node.js " + MinimumNodeMajor + " or newer was not found.");
        Console.WriteLine("[ThreeBrowser Studio] Download official Node.js " + NodeVersion + " (Windows x64) from nodejs.org");
        Console.WriteLine("[ThreeBrowser Studio] into %LOCALAPPDATA%\\ThreeBrowserStudio\\node ? [Y/N]");
        Console.Write("> ");
        return IsYes(Console.ReadLine() ?? "");
    }

    private static async Task DownloadOfficialNode(string destination)
    {
        var directory = Path.GetDirectoryName(destination) ?? throw new InvalidOperationException("Node cache path is invalid.");
        Directory.CreateDirectory(directory);
        var sumsPath = Path.Combine(directory, "SHASUMS256.txt");
        var tempPath = destination + ".download";
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
            Console.WriteLine("[ThreeBrowser Studio] Downloading checksums from nodejs.org...");
            var sums = await client.GetStringAsync(DistRoot + "SHASUMS256.txt");
            await File.WriteAllTextAsync(sumsPath, sums);
            var expected = ReadChecksum(sumsPath, "win-x64/node.exe");
            if (string.IsNullOrEmpty(expected))
            {
                throw new InvalidOperationException("nodejs.org checksum list did not include win-x64/node.exe.");
            }
            Console.WriteLine("[ThreeBrowser Studio] Downloading Node.js " + NodeVersion + "...");
            var bytes = await client.GetByteArrayAsync(DistRoot + "win-x64/node.exe");
            await File.WriteAllBytesAsync(tempPath, bytes);
            var actual = Sha256Hex(tempPath);
            if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Downloaded Node.js checksum did not match nodejs.org.");
            }
            if (File.Exists(destination)) File.Delete(destination);
            File.Move(tempPath, destination);
            Console.WriteLine("[ThreeBrowser Studio] Node.js " + NodeVersion + " is ready.");
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
            if (File.Exists(sumsPath)) File.Delete(sumsPath);
        }
    }

    private static string? FindNodeOnPath()
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        var parts = path.Split(new[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries);
        for (var index = 0; index < parts.Length; index++)
        {
            var candidate = Path.Combine(parts[index].Trim().Trim('"'), "node.exe");
            if (IsUsableNode(candidate)) return candidate;
        }
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var typical = Path.Combine(programFiles, "nodejs", "node.exe");
        return IsUsableNode(typical) ? typical : null;
    }

    private static string CachedNodePath()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(localAppData, "ThreeBrowserStudio", "node", "node.exe");
    }

    private static bool IsUsableNode(string filePath)
    {
        if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath)) return false;
        try
        {
            var start = new ProcessStartInfo();
            start.FileName = filePath;
            start.Arguments = "-e \"process.exit(Number(process.versions.node.split('.')[0]) >= " + MinimumNodeMajor + " ? 0 : 1)\"";
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (var process = Process.Start(start))
            {
                if (process == null) return false;
                if (!process.WaitForExit(15000))
                {
                    try { process.Kill(); } catch { }
                    return false;
                }
                return process.ExitCode == 0;
            }
        }
        catch
        {
            return false;
        }
    }

    private static string? ReadChecksum(string sumsPath, string fileName)
    {
        var lines = File.ReadAllLines(sumsPath);
        for (var index = 0; index < lines.Length; index++)
        {
            var line = lines[index].Trim();
            if (line.Length == 0) continue;
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length >= 2 && parts[1].Replace('\\', '/') == fileName) return parts[0];
        }
        return null;
    }

    private static string Sha256Hex(string filePath)
    {
        using (var sha = SHA256.Create())
        using (var stream = File.OpenRead(filePath))
        {
            return Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
        }
    }

    private static bool IsYes(string value)
    {
        if (string.IsNullOrEmpty(value)) return false;
        var text = value.Trim();
        return text == "1" || text.Equals("y", StringComparison.OrdinalIgnoreCase)
            || text.Equals("yes", StringComparison.OrdinalIgnoreCase);
    }

    private static string PackageRoot()
    {
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrEmpty(processPath))
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(processPath));
            if (!string.IsNullOrEmpty(directory)) return directory;
        }
        return AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    private static string FormatArgs(string[] args)
    {
        if (args == null || args.Length == 0) return string.Empty;
        var text = new StringBuilder();
        for (var index = 0; index < args.Length; index++)
        {
            text.Append(' ');
            text.Append(Quote(args[index]));
        }
        return text.ToString();
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
