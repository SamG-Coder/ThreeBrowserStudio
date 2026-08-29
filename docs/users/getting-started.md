# Install and first launch

This guide is for the Windows x64 zip. A development checkout is different;
see the repository `README.md`.

## What you need

- Windows x64
- A GPU that can present WebGPU through the ThreeBrowser host (Vulkan)
- Node.js 24 or newer, **or** permission for the launcher to download the
  official Windows x64 `node.exe` from nodejs.org on first run

The zip does **not** ship Node.js, ThreeC++ / threepp source, CMake trees,
samples, games, or NVIDIA DLSS / Streamline.

## Unpack and run

1. Extract the zip so you have a folder that contains `ThreeBrowserStudio.exe`,
   `app\`, and `host\`.
2. Double-click `ThreeBrowserStudio.exe`.
3. If Node 24+ is already on PATH, the window opens.
4. If Node is missing, the launcher asks to download official Node 24 into
   `%LOCALAPPDATA%\ThreeBrowserStudio\node`. You can also install Node yourself
   or set `THREE_STUDIO_NODE` to an exact `node.exe`.

`THREE_STUDIO_DOWNLOAD_NODE=1` skips the prompt (needed when stdin is
redirected).

## What should appear

One native WebGPU window. The side panel (Log / Explorer / Settings) is
retained chrome, not a property inspector. The first launch seeds a small
starter stage; later launches restore the last project.

Projects are **not** stored inside the unzipped folder. They live at
`%LOCALAPPDATA%\ThreeBrowserStudio\projects`. See
[Projects](./projects.md).

## After the window is open

Point Cursor, Grok Build, or Codex at the MCP server. The window must be
running first. See [Connect MCP](./connect-mcp.md).

## If it fails

- Extract the **whole** folder. The exe alone cannot find `app\` or `host\`.
- Confirm Node is 24+ (`node -v`).
- Confirm `host\build\bin\three_browser_runtime.node` and the companion DLLs
  are present. `three_native.dll` is the compiled host library, not source.
