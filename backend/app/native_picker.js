// Executed by macOS JavaScript for Automation. Arguments are data, never code.
ObjC.import("AppKit");

function run(argv) {
    const app = $.NSApplication.sharedApplication;
    app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
    const panel = $.NSOpenPanel.openPanel;
    panel.canChooseDirectories = true;
    panel.canChooseFiles = argv[0] === "files_and_directories";
    panel.allowsMultipleSelection = false;
    panel.canCreateDirectories = true;
    panel.resolvesAliases = true;
    panel.treatsFilePackagesAsDirectories = false;
    panel.title = argv[1];
    panel.prompt = "打开";
    if (argv[2]) panel.directoryURL = $.NSURL.fileURLWithPath(argv[2]);
    app.activateIgnoringOtherApps(true);
    const result = Number(panel.runModal);
    if (result === 0) {
        return JSON.stringify({ path: null, cancelled: true });
    }
    if (result !== 1) throw new Error("Native picker could not be displayed");
    return JSON.stringify({
        path: ObjC.unwrap(panel.URLs.objectAtIndex(0).path),
        cancelled: false,
    });
}
