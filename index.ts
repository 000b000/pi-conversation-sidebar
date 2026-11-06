/**
 * Conversation Sidebar
 *
 * A persistent conversation index docked to the right edge of the transcript
 * area in the fullscreen TUI. User prompts and completed assistant replies get their
 * own row. It reserves its own columns in the layout instead of drawing an
 * overlay, and it spans only the transcript area: its bottom border shares the
 * input dock's top border row, while the input dock and footer stay full width.
 *
 * Keys:
 *   alt+h          focus the sidebar / toggle it when already focused
 *   j, down        next message
 *   k, up          previous message
 *   [/]            move by one page (also ctrl+u / ctrl+d)
 *   g / G          first/last message (also home/end)
 *   enter          scroll the transcript to the selected message
 *   e              put a selected user prompt into the editor (only when empty)
 *   esc            return focus to the editor
 *   q              hide the sidebar
 *
 * Command:
 *   /sidebar [on|off|focus|toggle]
 */

import {
	AssistantMessageComponent,
	CustomEditor,
	parseSkillBlock,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	HStack,
	Spacer,
	VStack,
	isViewportTUI,
	matchesKey,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	type Component,
	type EditorTheme,
	type Focusable,
	type ScrollView,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const SIDEBAR_WIDTH = 38;
const SIDEBAR_MIN_WIDTH = 24;
const MAIN_MIN_WIDTH = 40;
const MIN_TERMINAL_WIDTH = 96;

type MessageRole = "user" | "assistant";

interface HistoryItem {
	id: string;
	role: MessageRole;
	text: string;
	preview: string;
}

interface SidebarCallbacks {
	onJump: (item: HistoryItem) => void;
	onEdit: (item: HistoryItem) => void;
	onExit: () => void;
	onHide: () => void;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

function firstLine(text: string): string {
	const normalized = text.replace(/\r/g, "");
	for (const rawLine of normalized.split("\n")) {
		const line = rawLine.replace(/\s+/g, " ").trim();
		if (line) return line;
	}
	return "(empty prompt)";
}

function userPreview(text: string): string {
	const skill = parseSkillBlock(text);
	if (!skill) return firstLine(text);
	const suffix = skill.userMessage ? firstLine(skill.userMessage) : "";
	return suffix ? `[skill: ${skill.name}] ${suffix}` : `[skill: ${skill.name}]`;
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as { content?: unknown; errorMessage?: unknown };
	const text = extractText(candidate.content);
	if (text.trim()) return text;
	return typeof candidate.errorMessage === "string" ? candidate.errorMessage : "";
}

function collectHistory(entries: SessionEntry[]): HistoryItem[] {
	const items: HistoryItem[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message.role;
		if (role === "user") {
			const text = extractText(entry.message.content);
			if (!text.trim()) continue;
			items.push({
				id: entry.id,
				role: "user",
				text,
				preview: userPreview(text),
			});
		} else if (role === "assistant") {
			const text = assistantText(entry.message);
			if (!text.trim()) continue;
			items.push({
				id: entry.id,
				role: "assistant",
				text,
				preview: firstLine(text),
			});
		}
	}
	return items;
}

function padToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

class ConversationSidebar implements Component, Focusable {
	focused = false;

	private items: HistoryItem[] = [];
	private selected = 0;
	private windowStart = 0;
	private bodyHeight = 1;

	constructor(
		private readonly tui: TUI,
		private readonly getTheme: () => Theme,
		private readonly getHeight: () => number,
		private readonly getFlushBottom: () => boolean,
		private readonly callbacks: SidebarCallbacks,
	) {}

	setItems(items: HistoryItem[], selectedId: string | undefined): void {
		this.items = items;
		const selectedIndex = selectedId ? items.findIndex((item) => item.id === selectedId) : -1;
		this.selected = selectedIndex >= 0 ? selectedIndex : Math.max(0, items.length - 1);
		this.clampSelection();
		this.tui.requestRender();
	}

	getSelectedId(): string | undefined {
		return this.items[this.selected]?.id;
	}

	invalidate(): void {
		// Rendering is cheap and always reads the current theme, so there is no
		// cached output to invalidate.
	}

	handleInput(data: string): void {
		if (this.tui.terminal.columns < MIN_TERMINAL_WIDTH) {
			this.callbacks.onExit();
			return;
		}
		if (matchesKey(data, "escape")) {
			this.callbacks.onExit();
			return;
		}
		if (matchesKey(data, "alt+h")) {
			this.callbacks.onHide();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.move(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.move(1);
			return;
		}
		// PageUp/PageDown are consumed by Pi's fullscreen transcript scroll
		// handler before they reach this component, so provide other list keys.
		if (matchesKey(data, "pageUp") || data === "[" || matchesKey(data, "ctrl+u")) {
			this.move(-Math.max(1, this.bodyHeight - 1));
			return;
		}
		if (matchesKey(data, "pageDown") || data === "]" || matchesKey(data, "ctrl+d")) {
			this.move(Math.max(1, this.bodyHeight - 1));
			return;
		}
		if (matchesKey(data, "home") || data === "g") {
			this.select(0);
			return;
		}
		if (matchesKey(data, "end") || data === "G") {
			this.select(this.items.length - 1);
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter") || data === "\r") {
			this.activate("jump");
			return;
		}
		if (data === "e") {
			this.activate("edit");
			return;
		}
		if (data === "q") {
			this.callbacks.onHide();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			this.move(delta < 0 ? -3 : 3);
			return { handled: true };
		}
		if (event.type === "click" && event.button === "left") {
			const index = this.itemIndexAt(event.y);
			if (index !== undefined) {
				this.selected = index;
				this.clampSelection();
				this.activate("jump");
			}
			return { handled: true, focus: true };
		}
		return undefined;
	}

	render(width: number): string[] {
		const theme = this.getTheme();
		const rows = Math.max(1, Math.floor(this.getHeight()));
		const safeWidth = Math.max(1, Math.floor(width));

		if (safeWidth < 8) {
			return Array.from({ length: rows }, () => " ".repeat(safeWidth));
		}

		const inner = safeWidth - 2;
		const borderColor = this.focused ? "borderAccent" : "border";
		const fence = (text: string) => theme.fg(borderColor, text);
		const accentFence = (text: string) => theme.fg("borderAccent", text);

		const lines: string[] = [];
		const flushBottom = this.getFlushBottom();
		const title = truncateToWidth(" Conversation ", inner, "…");
		const titleFill = "─".repeat(Math.max(0, inner - visibleWidth(title)));
		lines.push(`${accentFence("┌")}${theme.fg("accent", title)}${fence(titleFill)}${accentFence("┐")}`);

		if (rows < 6) {
			const bodyRows = Math.max(0, rows - (flushBottom ? 1 : 2));
			for (let i = 0; i < bodyRows; i++) {
				const content = i === 0 ? this.renderStatusInner(inner, theme) : "";
				lines.push(`${fence("│")}${this.styleRow(content, inner, false, theme)}${fence("│")}`);
			}
			if (!flushBottom) lines.push(`${accentFence("└")}${fence("─".repeat(inner))}${accentFence("┘")}`);
			return lines.slice(0, rows);
		}

		this.bodyHeight = Math.max(1, rows - (flushBottom ? 3 : 4));
		this.clampSelection();
		const maxStart = Math.max(0, this.items.length - this.bodyHeight);
		this.windowStart = clamp(this.selected - Math.floor(this.bodyHeight / 2), 0, maxStart);

		for (let offset = 0; offset < this.bodyHeight; offset++) {
			const index = this.windowStart + offset;
			const item = this.items[index];
			let content = "";
			let selected = false;
			if (item) {
				selected = index === this.selected;
				content = this.renderItemInner(item, inner, theme);
			}
			lines.push(`${fence("│")}${this.styleRow(content, inner, selected, theme)}${fence("│")}`);
		}

		lines.push(`${fence("│")}${this.styleRow(this.renderStatusInner(inner, theme), inner, false, theme)}${fence("│")}`);
		lines.push(`${fence("│")}${this.styleRow(this.renderHelpInner(inner, theme), inner, false, theme)}${fence("│")}`);
		if (!flushBottom) lines.push(`${accentFence("└")}${fence("─".repeat(inner))}${accentFence("┘")}`);
		return lines.slice(0, rows);
	}

	private renderItemInner(item: HistoryItem, inner: number, theme: Theme): string {
		const glyph = item.role === "user" ? "▸" : "↳";
		const clipped = truncateToWidth(`${glyph} ${item.preview}`, inner, "…");
		return theme.fg(item.role === "assistant" ? "muted" : "text", clipped);
	}

	private styleRow(content: string, inner: number, selected: boolean, theme: Theme): string {
		const padded = padToWidth(content, inner);
		if (!selected) return padded;
		return theme.bg("selectedBg", theme.fg("text", padded));
	}

	private renderStatusInner(inner: number, theme: Theme): string {
		const total = this.items.length;
		if (total === 0) return theme.fg("dim", " no conversation yet");
		const first = this.windowStart + 1;
		const last = Math.min(total, this.windowStart + this.bodyHeight);
		const range = first === 1 && last === total ? "" : `  ·  ${first}-${last}`;
		return theme.fg("dim", ` ${total} message${total === 1 ? "" : "s"}${range}`);
	}

	private renderHelpInner(inner: number, theme: Theme): string {
		const help = this.focused
			? " j/k  enter jump  e edit  esc"
			: " alt+h focus  ·  click jump";
		return theme.fg("dim", truncateToWidth(help, inner, "…"));
	}

	private itemIndexAt(y: number): number | undefined {
		const offset = y - 1;
		if (offset < 0 || offset >= this.bodyHeight) return undefined;
		const index = this.windowStart + offset;
		return index < this.items.length ? index : undefined;
	}

	private clampSelection(): void {
		if (this.items.length === 0) {
			this.selected = 0;
			this.windowStart = 0;
		} else {
			this.selected = clamp(this.selected, 0, this.items.length - 1);
		}
	}

	private move(delta: number): void {
		this.select(this.selected + delta);
	}

	private select(index: number): void {
		if (this.items.length === 0) return;
		const next = clamp(index, 0, this.items.length - 1);
		if (next === this.selected) return;
		this.selected = next;
		this.tui.requestRender();
	}

	private activate(action: "jump" | "edit"): void {
		const item = this.items[this.selected];
		if (!item) return;
		if (action === "jump") this.callbacks.onJump(item);
		else this.callbacks.onEdit(item);
	}
}

/**
 * A stock CustomEditor whose only purpose is to capture the TUI instance and
 * the editor component so the sidebar can install itself and return focus.
 */
class SidebarEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getSidebarBottom: () => string | undefined,
	) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
	}

	protected renderTopBorder(width: number, hiddenLineCount: number): string {
		const base = super.renderTopBorder(width, hiddenLineCount);
		const segment = this.getSidebarBottom();
		if (!segment) return base;
		const segmentWidth = visibleWidth(segment);
		if (segmentWidth <= 0 || width <= segmentWidth) return base;
		const leftWidth = width - segmentWidth;
		let left = sliceByColumn(base, 0, leftWidth, true);
		const leftVisible = visibleWidth(left);
		if (leftVisible < leftWidth) left += " ".repeat(leftWidth - leftVisible);
		return left + segment;
	}
}

function isUserMessageComponent(node: unknown): node is UserMessageComponent {
	if (!node || typeof node !== "object") return false;
	if (node instanceof UserMessageComponent) return true;
	const candidate = node as { constructor?: { name?: string }; text?: unknown };
	return candidate.constructor?.name === "UserMessageComponent" && typeof candidate.text === "string";
}

function isAssistantMessageComponent(node: unknown): node is AssistantMessageComponent {
	if (!node || typeof node !== "object") return false;
	if (node instanceof AssistantMessageComponent) return true;
	const candidate = node as { constructor?: { name?: string } };
	return candidate.constructor?.name === "AssistantMessageComponent";
}

interface MessageComponents {
	users: UserMessageComponent[];
	assistants: AssistantMessageComponent[];
}

function collectMessageComponents(root: unknown): MessageComponents {
	const found: MessageComponents = { users: [], assistants: [] };
	const visit = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		if (isUserMessageComponent(node)) {
			found.users.push(node);
			return;
		}
		if (isAssistantMessageComponent(node)) {
			found.assistants.push(node);
			return;
		}
		const children = (node as { children?: unknown }).children;
		if (Array.isArray(children)) {
			for (const child of children) visit(child);
		}
	};
	visit(root);
	return found;
}

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function mapItemsToComponents<C>(
	items: HistoryItem[],
	components: C[],
	getText: (component: C) => string,
): Map<string, C> {
	const result = new Map<string, C>();
	if (items.length === 0 || components.length === 0) return result;
	if (items.length === components.length) {
		items.forEach((item, index) => result.set(item.id, components[index]!));
		return result;
	}

	let searchFrom = 0;
	for (const item of items) {
		const wanted = normalizeText(item.text);
		const probe = wanted.slice(0, Math.min(48, wanted.length));
		let match = -1;
		for (let i = searchFrom; i < components.length; i++) {
			const candidate = normalizeText(getText(components[i]!));
			if (candidate === wanted || (probe.length > 0 && candidate.startsWith(probe))) {
				match = i;
				break;
			}
		}
		if (match < 0) {
			for (let i = 0; i < components.length; i++) {
				const candidate = normalizeText(getText(components[i]!));
				if (candidate === wanted || (probe.length > 0 && candidate.startsWith(probe))) {
					match = i;
					break;
				}
			}
		}
		if (match >= 0) {
			result.set(item.id, components[match]!);
			searchFrom = match + 1;
		}
	}
	return result;
}

function findPath(root: unknown, target: unknown): unknown[] | undefined {
	const path: unknown[] = [];
	const visit = (node: unknown): boolean => {
		path.push(node);
		if (node === target) return true;
		const children = (node as { children?: unknown }).children;
		if (Array.isArray(children)) {
			for (const child of children) {
				if (visit(child)) return true;
			}
		}
		path.pop();
		return false;
	};
	return visit(root) ? path : undefined;
}

function renderedHeight(component: unknown, width: number): number {
	try {
		const render = (component as { render?: (width: number) => string[] }).render;
		return typeof render === "function" ? render.call(component, width).length : 0;
	} catch {
		return 0;
	}
}

function rowOfComponent(root: unknown, target: unknown, width: number): number | undefined {
	const path = findPath(root, target);
	if (!path) return undefined;
	let row = 0;
	for (let depth = 0; depth < path.length - 1; depth++) {
		const parent = path[depth] as { children?: unknown };
		const next = path[depth + 1];
		if (!Array.isArray(parent.children)) return undefined;
		for (const child of parent.children) {
			if (child === next) break;
			row += renderedHeight(child, width);
		}
	}
	return row;
}

function findScrollBox(tui: TUI, scrollView: ScrollView): { rect?: { width?: number } } | undefined {
	const layout = (tui as unknown as { currentLayout?: { root?: unknown } }).currentLayout;
	const root = layout?.root;
	if (!root) return undefined;
	const queue: unknown[] = [root];
	while (queue.length > 0) {
		const box = queue.shift() as { scrollView?: unknown; children?: unknown[] };
		if (box.scrollView === scrollView) return box as { rect?: { width?: number } };
		if (Array.isArray(box.children)) queue.push(...box.children);
	}
	return undefined;
}

function isScrollViewLike(node: unknown): boolean {
	if (!node || typeof node !== "object") return false;
	const candidate = node as { getContentWidth?: unknown; scrollTo?: unknown; scrollTop?: unknown };
	return (
		typeof candidate.getContentWidth === "function" &&
		typeof candidate.scrollTo === "function" &&
		typeof candidate.scrollTop === "number"
	);
}

class ConversationSidebarManager {
	private ctx: ExtensionContext | undefined;
	private tui: TUI | undefined;
	private editor: SidebarEditor | undefined;
	private sidebar: ConversationSidebar | undefined;
	private originalRoot: Component | undefined;
	private wrapper: VStack | undefined;
	private dock: Component | undefined;
	private dockGap: { container: { children: Component[]; invalidate?: () => void }; spacer: Component } | undefined;
	private items: HistoryItem[] = [];
	private selectedId: string | undefined;
	private visible = true;
	private installed = false;
	private warnedUnsupported = false;

	start(ctx: ExtensionContext): void {
		this.stop();
		this.ctx = ctx;
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
			const editor = new SidebarEditor(tui, editorTheme, keybindings, () => this.sidebarBottomSegment());
			this.tui = tui;
			this.editor = editor;
			this.install(tui);
			return editor;
		});

		this.refresh();
		// Other extensions may add widgets above the editor during session_start,
		// recreating pi's leading spacer. Remove it once more after they settle.
		setTimeout(() => {
			if (!this.tui || !this.installed) return;
			this.removeDockLeadingGap();
			this.tui.requestRender();
		}, 0);
	}

	stop(): void {
		const tui = this.tui;
		const wrapper = this.wrapper;
		this.restoreDockLeadingGap();
		if (this.isSidebarFocused()) this.focusEditor();
		try {
			if (tui && wrapper && (tui as unknown as { layoutRoot?: unknown }).layoutRoot === wrapper) {
				(tui as unknown as { setLayoutRoot: (component: Component | undefined) => void }).setLayoutRoot(this.originalRoot);
				tui.requestRender();
			}
		} catch {
			// The TUI may already be shutting down.
		}
		this.installed = false;
		this.wrapper = undefined;
		this.originalRoot = undefined;
		this.dock = undefined;
		this.sidebar = undefined;
		this.editor = undefined;
		this.tui = undefined;
		this.ctx = undefined;
		this.items = [];
		this.selectedId = undefined;
	}

	refresh(ctx?: ExtensionContext): void {
		if (ctx) this.ctx = ctx;
		this.removeDockLeadingGap();
		const context = this.ctx;
		if (!context) return;

		let entries: SessionEntry[] = [];
		try {
			entries = context.sessionManager.buildContextEntries();
		} catch {
			return;
		}

		const items = collectHistory(entries);
		this.selectedId = this.sidebar?.getSelectedId() ?? this.selectedId;
		const previousLastId = this.items[this.items.length - 1]?.id;
		const wasAtLatest = !this.selectedId || this.selectedId === previousLastId;

		this.items = items;
		let selectedId = this.selectedId;
		if (!selectedId || !items.some((item) => item.id === selectedId)) {
			selectedId = items[items.length - 1]?.id;
		} else if (wasAtLatest && previousLastId && items[items.length - 1]?.id !== previousLastId) {
			selectedId = items[items.length - 1]?.id ?? selectedId;
		}
		this.selectedId = selectedId;
		this.sidebar?.setItems(items, selectedId);
		this.tui?.requestRender();
	}

	toggleVisibility(): void {
		if (!this.ensureInstalled()) return;
		this.setVisible(!this.visible);
	}

	toggle(): void {
		if (!this.ensureInstalled()) return;
		const focused = this.isSidebarFocused();
		if (!this.visible) {
			this.setVisible(true);
			this.focusSidebar();
		} else if (focused) {
			this.setVisible(false);
		} else {
			this.focusSidebar();
		}
	}

	setVisible(visible: boolean): void {
		if (!this.ensureInstalled()) return;
		const wasFocused = this.isSidebarFocused();
		this.visible = visible;
		if (!visible && wasFocused) this.focusEditor();
		this.tui?.requestRender();
	}

	focusSidebar(): void {
		if (!this.ensureInstalled() || !this.sidebar || !this.tui) return;
		if (this.tui.terminal.columns < MIN_TERMINAL_WIDTH) {
			this.ctx?.ui.notify(`Terminal is too narrow for the conversation sidebar (need at least ${MIN_TERMINAL_WIDTH} columns)`, "warning");
			return;
		}
		if (!this.visible) this.visible = true;
		this.tui.requestRender();
		this.tui.setFocus(this.sidebar);
	}

	focusEditor(): void {
		if (this.tui && this.editor) this.tui.setFocus(this.editor);
	}

	editPrompt(item: HistoryItem): void {
		if (!this.editor) return;
		if (item.role !== "user") {
			this.ctx?.ui.notify("Only user prompts can be loaded into the editor", "info");
			return;
		}
		if (this.editor.getText().trim().length > 0) {
			this.ctx?.ui.notify("Clear the editor before loading a previous prompt", "warning");
			return;
		}
		this.editor.setText(item.text);
		this.focusEditor();
	}

	jumpTo(item: HistoryItem): void {
		const tui = this.tui;
		if (!tui) return;
		const tuiAny = tui as unknown as {
			getPrimaryScrollView?: () => ScrollView;
			currentLayout?: { primaryScrollView?: ScrollView };
		};
		const scrollView = tuiAny.getPrimaryScrollView?.() ?? tuiAny.currentLayout?.primaryScrollView;
		if (!scrollView) {
			this.ctx?.ui.notify("Conversation jumping requires fullscreen TUI mode", "warning");
			return;
		}

		const content =
			(scrollView as unknown as { child?: unknown }).child ??
			(scrollView as unknown as { children?: unknown[] }).children?.[0];
		if (!content) {
			this.ctx?.ui.notify("Could not read the transcript layout", "warning");
			return;
		}

		const components = collectMessageComponents(content);
		const userItems = this.items.filter((entry) => entry.role === "user");
		const assistantItems = this.items.filter((entry) => entry.role === "assistant");
		const userMapping = mapItemsToComponents(userItems, components.users, (component) => {
			return String((component as unknown as { text?: string }).text ?? "");
		});
		const assistantMapping = mapItemsToComponents(assistantItems, components.assistants, (component) => {
			return assistantText((component as unknown as { lastMessage?: unknown }).lastMessage);
		});
		const target = item.role === "user" ? userMapping.get(item.id) : assistantMapping.get(item.id);
		if (!target) {
			this.ctx?.ui.notify("Could not locate that message in the transcript (compaction may have hidden it)", "warning");
			return;
		}

		const box = findScrollBox(tui, scrollView);
		const viewportWidth = box?.rect?.width ?? Math.max(1, tui.terminal.columns - (this.visible ? SIDEBAR_WIDTH : 0) - 2);
		const contentWidth = scrollView.getContentWidth(viewportWidth);
		const row = rowOfComponent(content, target, contentWidth);
		if (row === undefined) {
			this.ctx?.ui.notify("Could not calculate the transcript position", "warning");
			return;
		}

		scrollView.scrollTo(row, { disableFollow: true });
		tui.requestRender();
	}

	private ensureInstalled(): boolean {
		if (this.installed) return true;
		if (this.ctx?.mode === "tui" && !this.warnedUnsupported) {
			this.warnedUnsupported = true;
			this.ctx.ui.notify("Conversation sidebar needs fullscreen TUI mode (set tuiMode to fullscreen)", "warning");
		}
		return false;
	}

	private install(tui: TUI): void {
		if (this.installed) return;
		if (!isViewportTUI(tui)) {
			this.ensureInstalled();
			return;
		}

		const tuiAny = tui as unknown as {
			layoutRoot?: Component;
			setLayoutRoot: (component: Component | undefined) => void;
		};
		const root = tuiAny.layoutRoot;
		if (!root) {
			// The UI is normally mounted before session_start. Retry once for
			// unusual startup paths where the layout root is created later.
			setTimeout(() => {
				if (this.tui === tui && !this.installed) this.install(tui);
			}, 0);
			return;
		}

		const rootChildren = (root as unknown as { children?: Component[] }).children;
		const transcript = Array.isArray(rootChildren) ? rootChildren.find((child) => isScrollViewLike(child)) : undefined;
		const dock = transcript && Array.isArray(rootChildren)
			? rootChildren.find((child) => child !== transcript)
			: undefined;
		if (!transcript || !dock) {
			this.ctx?.ui.notify("Conversation sidebar: unsupported fullscreen layout structure", "warning");
			return;
		}

		this.originalRoot = root;
		this.dock = dock;
		this.removeDockLeadingGap();
		this.sidebar = new ConversationSidebar(
			tui,
			() => this.ctx!.ui.theme,
			() => this.sidebarHeight(),
			() => this.shouldFlushBottom(),
			{
				onJump: (item) => this.jumpTo(item),
				onEdit: (item) => this.editPrompt(item),
				onExit: () => this.focusEditor(),
				onHide: () => this.setVisible(false),
			},
		);

		const sidebar = this.sidebar;
		const upper = new HStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: MAIN_MIN_WIDTH },
			{
				component: sidebar,
				basis: SIDEBAR_WIDTH,
				grow: 0,
				shrink: 1,
				minSize: SIDEBAR_MIN_WIDTH,
				visible: (viewport) => this.visible && viewport.width >= MIN_TERMINAL_WIDTH,
			},
		]);
		const wrapper = new VStack([
			{ component: upper, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		this.wrapper = wrapper;
		this.installed = true;
		tuiAny.setLayoutRoot(wrapper);
		this.refresh();
	}

	private removeDockLeadingGap(): void {
		const dockChildren = (this.dock as unknown as { children?: Component[] } | undefined)?.children;
		if (!Array.isArray(dockChildren) || dockChildren.length < 3) return;
		// pi's dock order is pending/status/widgetsAbove/editor/widgetsBelow/footer.
		const widgetsAbove = dockChildren[2] as { children?: Component[]; invalidate?: () => void } | undefined;
		const children = widgetsAbove?.children;
		if (!Array.isArray(children) || children.length === 0) return;
		const first = children[0] as { constructor?: { name?: string }; render?: (width: number) => string[] };
		if (!first || (first !== this.dockGap?.spacer && !(first instanceof Spacer) && first.constructor?.name !== "Spacer")) {
			return;
		}
		let height = 1;
		try {
			height = first.render?.(1).length ?? 1;
		} catch {
			height = 1;
		}
		if (height !== 1) return;
		children.shift();
		this.dockGap = {
			container: widgetsAbove as { children: Component[]; invalidate?: () => void },
			spacer: first as Component,
		};
		widgetsAbove?.invalidate?.();
	}

	private restoreDockLeadingGap(): void {
		const gap = this.dockGap;
		this.dockGap = undefined;
		if (!gap) return;
		const children = gap.container.children;
		if (!Array.isArray(children)) return;
		const first = children[0] as { constructor?: { name?: string } } | undefined;
		if (first === gap.spacer) return;
		if (first && (first instanceof Spacer || first.constructor?.name === "Spacer")) return;
		children.unshift(gap.spacer);
		gap.container.invalidate?.();
	}

	private shouldFlushBottom(): boolean {
		if (!this.installed || !this.visible || !this.tui || !this.dock || !this.editor) return false;
		if (this.tui.terminal.columns < MIN_TERMINAL_WIDTH) return false;
		const dockChildren = (this.dock as unknown as { children?: Component[] }).children;
		if (!Array.isArray(dockChildren)) return false;
		const editorIndex = dockChildren.findIndex((child) => findPath(child, this.editor) !== undefined);
		if (editorIndex < 0) return false;
		let aboveHeight = 0;
		for (let i = 0; i < editorIndex; i++) {
			try {
				aboveHeight += dockChildren[i]!.render(this.tui.terminal.columns).length;
			} catch {
				return false;
			}
		}
		return aboveHeight === 0;
	}

	private sidebarBottomSegment(): string | undefined {
		if (!this.shouldFlushBottom()) return undefined;
		const theme = this.ctx?.ui.theme;
		if (!theme) return undefined;
		const color = this.isSidebarFocused() ? "borderAccent" : "border";
		return theme.fg(color, `└${"─".repeat(Math.max(0, SIDEBAR_WIDTH - 2))}┘`);
	}

	private sidebarHeight(): number {
		const tui = this.tui;
		if (!tui) return 1;
		let dockHeight = 0;
		if (this.dock) {
			try {
				dockHeight = this.dock.render(tui.terminal.columns).length;
			} catch {
				dockHeight = 0;
			}
		}
		return Math.max(1, tui.terminal.rows - dockHeight);
	}

	private isSidebarFocused(): boolean {
		if (!this.tui || !this.sidebar) return false;
		const focused = (this.tui as unknown as { getFocusedComponent?: () => Component | null }).getFocusedComponent?.();
		return focused === this.sidebar;
	}
}

export default function conversationSidebarExtension(pi: ExtensionAPI) {
	const manager = new ConversationSidebarManager();

	pi.on("session_start", (_event, ctx) => manager.start(ctx));
	pi.on("session_shutdown", () => manager.stop());
	pi.on("session_tree", (_event, ctx) => manager.refresh(ctx));
	pi.on("session_compact", (_event, ctx) => manager.refresh(ctx));
	pi.on("turn_start", (_event, ctx) => manager.refresh(ctx));
	pi.on("turn_end", (_event, ctx) => manager.refresh(ctx));
	pi.on("agent_start", (_event, ctx) => manager.refresh(ctx));
	pi.on("agent_end", (_event, ctx) => manager.refresh(ctx));

	pi.registerCommand("sidebar", {
		description: "Show, hide, or focus the conversation history sidebar",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("Conversation sidebar requires interactive TUI mode", "warning");
				return;
			}
			manager.refresh(ctx);
			const action = args.trim().toLowerCase();
			if (action === "off" || action === "hide") {
				manager.setVisible(false);
			} else if (action === "on" || action === "show") {
				manager.setVisible(true);
			} else if (action === "focus") {
				manager.focusSidebar();
			} else if (action === "" || action === "toggle") {
				manager.toggleVisibility();
			} else {
				ctx.ui.notify("Usage: /sidebar [on|off|focus|toggle]", "warning");
			}
		},
	});

	pi.registerShortcut("alt+h", {
		description: "Focus or toggle the conversation history sidebar",
		handler: () => manager.toggle(),
	});
}
