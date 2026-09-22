import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("../extensions/execution-progress.ts", import.meta.url));
const source = readFileSync(extensionPath, "utf8");

test("progress panel stays fixed in the top-right overlay", () => {
	assert.match(source, /anchor:\s*["']top-right["']/);
	assert.match(source, /width:\s*58/);
	assert.doesNotMatch(source, /maxHeight:/);
	assert.match(source, /\(tui, theme, _keybindings, done\) => \{[\s\S]*?activeTui = tui;/);
	assert.match(source, /nonCapturing:\s*true/);
});

test("Command+L toggles panel visibility without changing its layout", () => {
	assert.match(source, /const SHOW_SHORTCUT = Key\.super\("l"\)/);
	assert.match(source, /if \(overlayVisible\) \{[\s\S]*?hideOverlay\(\);[\s\S]*?return;/);
	assert.match(source, /if \(overlayVisible\) \{[\s\S]*?return;\n\s*}\n\s*if \(state\.phases\.length === 0\) return;/);
	assert.match(source, /await ensureOverlay\(ctx\);[\s\S]*?showOverlay\(\);/);
	assert.doesNotMatch(source, /setExpanded\(|isExpanded\(|toggleOverlay\(/);
});

test("panel uses an opaque themed background and lists every phase", () => {
	assert.match(source, /const PANEL_BACKGROUND = "customMessageBg"/);
	assert.match(source, /const PANEL_BORDER = "borderMuted"/);
	assert.match(source, /theme\.bg\(\s*PANEL_BACKGROUND/);
	assert.match(source, /theme\.fg\(PANEL_BORDER/);
	assert.match(source, /"▌"/);
	assert.doesNotMatch(source, /this\.border\(/);
	assert.doesNotMatch(source, /state\.sourceDoc\) lines\.push/);
	assert.doesNotMatch(source, /固定面板 · Command\+L 显示\/隐藏/);
	assert.match(source, /for \(const phase of state\.phases\) lines\.push/);
	assert.doesNotMatch(source, /MAX_VISIBLE_PHASES|scrollOffset|后续/);
});

test("panel does not register conflicting Escape or Ctrl+C handling", () => {
	assert.doesNotMatch(source, /matchesKey\([^\n]*escape/);
	assert.doesNotMatch(source, /ctrl\+c|Ctrl\+C/);
	assert.doesNotMatch(source, /ctrl\+alt\+p|ctrl\+alt\+shift\+p/);
});

test("completed plans release the overlay and footer status", () => {
	assert.match(source, /function releaseOverlay\(\)/);
	assert.match(source, /state\.phases\.every\(\(candidate\) => candidate\.status === "done"\)/);
	assert.match(source, /if \(summary\.total === 0 \|\| !hasOpenPlan\(state\)\)/);
	assert.match(source, /if \(hasOpenPlan\(state\)\) void ensureOverlay\(ctx\);\n\s*else releaseOverlay\(\);/);
});

test("explicit show can reopen retained completed history and waits for closing overlays", () => {
	assert.match(source, /if \(state\.phases\.length === 0\) return errorResult\(action, "no execution plan has been created"\)/);
	assert.match(source, /if \(state\.phases\.length === 0\) return;\n\s*await ensureOverlay\(ctx\);\n\s*showOverlay\(\);/);
	assert.match(source, /let overlayClosing = false/);
	assert.match(source, /if \(!overlayClosing\)[\s\S]*?showOverlay\(\);[\s\S]*?await overlayPromise/);
});

test("first direct edit/write mutation has an automatic fallback plan", () => {
	assert.match(source, /function isMutatingToolCall\(toolName: string, _input: unknown\)/);
	assert.match(source, /return toolName === "edit" \|\| toolName === "write"/);
	assert.match(source, /function automaticFallbackPlan\(\)/);
	assert.match(source, /pi\.on\("tool_call", async \(event, ctx\) =>/);
	assert.match(source, /await createAutomaticFallbackPlan\(ctx\)/);
	assert.match(source, /event\.toolName === TOOL_NAME/);
});

test("custom Overlay prompts do not become user-input waits", () => {
	assert.match(source, /if \(event\.kind === "custom"\) return;/g);
});

test("responsive-hidden Overlays stop Spinner work", () => {
	assert.match(source, /let responsiveVisible = false/);
	assert.match(source, /overlayVisible && responsiveVisible && hasOpenPlan\(state\)/);
	assert.match(source, /visible: \(termWidth\) => \{[\s\S]*?responsiveVisible = termWidth >= 120/);
	assert.match(source, /if \(!responsiveVisible\) stopSpinner\(\)/);
});

test("only active execution animates and the timer is released", () => {
	assert.match(source, /const SPINNER_FRAMES = \[/);
	assert.match(source, /summary\.label === "执行中"/);
	assert.match(source, /spinnerTimer = setInterval\(/);
	assert.match(source, /function stopSpinner\(\)/);
	assert.match(source, /clearInterval\(spinnerTimer\)/);
	assert.match(source, /stopSpinner\(\);\n\s*ctx\.ui\.setStatus/);
});
