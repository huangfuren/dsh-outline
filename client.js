// dsh-outline 浏览器半区（单文件模块，无外部构建依赖）
//
// 职责：在 设置 → 插件 → 插件配置 注册一张配置卡片（settings.plugin.item 槽位，
// key = 'outline-auto' 命名空间），编辑 Outline 知识库连接的 baseUrl / apiToken / writablePaths。
// 卡片外观与官方卡片（终端 / Agent 循环 / 网页搜索）保持一致：可折叠头部 +
// chevron + 字段组 + 底部操作栏，样式使用同一套 --dsw-alias-* 主题变量。
// 数据经 settingsScope 服务写入宿主端 settings.yaml 的 outline-auto 命名空间，
// 宿主插件（lib/index.js）通过 settings.installSection 读取，保存后实时生效。
window.__ModuleLoader__.load({
	id: "dsh-outline",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");

		// 字典命名空间与 settings 命名空间 / 槽位 key（三者同名便于定位）
		const NS = "settings.outlineAuto";
		const NS_KEY = "outline-auto";

		// 与官方卡片一致的中文/英文文案（对齐 ui-settings-plugins locales）
		const zh = {
			cardTitle: "Outline 知识库",
			cardDescription: "在对话中搜索 / 读取你的 Outline 知识库文档。",
			baseUrl: "服务地址 (baseUrl)",
			baseUrlHint: "Outline 实例根地址，如 https://outline.example.com",
			apiToken: "API Token",
			apiTokenHint: "Outline 设置 → API 密钥 中生成",
			writablePaths: "可写目录（留空 = 只读）",
			writablePathsHint: "逗号分隔目录路径，如 集合A,集合B/目录1；仅这些目录及其子级可写入，默认全库只读",
			overridden: "已覆盖",
			reset: "恢复默认",
			configured: "已配置",
			notConfigured: "未配置",
			removeUrl: "移除地址",
			removeToken: "移除 Token",
			removeWritable: "清空可写目录",
			confirmRemoveUrl: "确定要移除已保存的 Outline 服务地址吗？",
			confirmRemoveToken: "确定要移除已保存的 API Token 吗？",
			confirmRemoveWritable: "确定要清空可写目录吗？清空后插件回到只读模式。",
			localSaveDir: "本地保存目录",
			localSaveDirHint: "把搜索结果/文档存为 Markdown 的本地目录；留空 = $DSH_HOME/outline-auto-saves。需重启 web profile 后生效。",
			removeSaveDir: "清空本地保存目录",
			confirmRemoveSaveDir: "确定要清空本地保存目录吗？清空后回退到默认位置。",
			keepUrlPlaceholder: "留空将清除当前地址；输入新地址以替换",
			keepTokenPlaceholder: "留空将清除当前 Token；输入新 API Token 以替换",
			tokenHintConfigured: "已配置。星号为占位，真实值不会被显示。",
			saved: "已保存。新会话将使用更新后的配置。",
			readonlyMode: "只读",
			writableMode: "可写",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改",
			unsaved: "未保存",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			readOnly: "本部署的设置为只读。",
			expand: "展开设置",
			collapse: "收起设置",
			emptyPlaceholder: "留空表示使用默认值",
		};
		const en = {
			cardTitle: "Outline Knowledge Base",
			cardDescription: "Search / read your Outline knowledge base documents from conversations.",
			baseUrl: "Service URL (baseUrl)",
			baseUrlHint: "Outline instance root, e.g. https://outline.example.com",
			apiToken: "API Token",
			apiTokenHint: "Create one at Outline Settings → API keys",
			writablePaths: "Writable paths (empty = read-only)",
			writablePathsHint: "Comma-separated paths, e.g. CollectionA,CollectionB/Dir1; only these directories and their children are writable. Empty means read-only.",
			overridden: "Overridden",
			reset: "Reset",
			configured: "Configured",
			notConfigured: "Not configured",
			removeUrl: "Remove URL",
			removeToken: "Remove Token",
			removeWritable: "Clear writable paths",
			confirmRemoveUrl: "Remove the saved Outline service URL?",
			confirmRemoveToken: "Remove the saved API Token?",
			confirmRemoveWritable: "Clear the writable paths? The plugin returns to read-only mode.",
			localSaveDir: "Local save directory",
			localSaveDirHint: "Local directory where search results/documents are saved as Markdown; empty = $DSH_HOME/outline-auto-saves. Restart the web profile after changing.",
			removeSaveDir: "Clear local save directory",
			confirmRemoveSaveDir: "Clear the local save directory? It falls back to the default location.",
			keepUrlPlaceholder: "Leave blank to clear the current URL; enter a new URL to replace it",
			keepTokenPlaceholder: "Leave blank to clear the current token; enter a new API Token to replace it",
			tokenHintConfigured: "Configured. The stars are a placeholder; the real value is never shown.",
			saved: "Saved. New conversations will use the updated configuration.",
			readonlyMode: "Read-only",
			writableMode: "Writable",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			unsaved: "Unsaved",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			readOnly: "This deployment stores settings read-only.",
			expand: "Show settings",
			collapse: "Hide settings",
			emptyPlaceholder: "Leave empty to use the default",
		};

		const FIELDS = ["baseUrl", "apiToken", "writablePaths", "localSaveDir"];

		// 仅用于视觉提示的占位符，永远不会写入设置（敏感值统一掩码处理）。
		const MASK = "*".repeat(28);

		/**
		 * 复刻官方 PluginCard.module.css / fields.module.css 的样式规则，
		 * 类名加 dsh-oac- 前缀避免冲突；颜色全部走 --dsw-alias-* 主题变量。
		 */
		const CSS_TEXT = [
			".dsh-oac-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}",
			".dsh-oac-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".dsh-oac-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".dsh-oac-header{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}",
			".dsh-oac-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
			".dsh-oac-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}",
			".dsh-oac-name{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}",
			".dsh-oac-description{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".dsh-oac-chevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}",
			".dsh-oac-chevronOpen{transform:rotate(180deg)}",
			".dsh-oac-pending{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
			".dsh-oac-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}",
			".dsh-oac-readOnly{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".dsh-oac-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
			".dsh-oac-field+.dsh-oac-field{border-top:1px solid var(--dsw-alias-border-l2)}",
			".dsh-oac-head{display:flex;align-items:center;gap:8px}",
			".dsh-oac-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			".dsh-oac-badges{display:inline-flex;align-items:center;gap:8px}",
			".dsh-oac-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;font-weight:500;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}",
			".dsh-oac-badgeOk{color:#2f9e44}",
			".dsh-oac-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dsh-oac-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".dsh-oac-reset:disabled{cursor:default}",
			".dsh-oac-input{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}",
			".dsh-oac-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}",
			".dsh-oac-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".dsh-oac-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".dsh-oac-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}",
			".dsh-oac-failed{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}",
			".dsh-oac-msg{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}",
			".dsh-oac-discard,.dsh-oac-save{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}",
			".dsh-oac-discard{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}",
			".dsh-oac-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
			".dsh-oac-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
			".dsh-oac-discard:disabled,.dsh-oac-save:disabled{opacity:.4;cursor:default}",
			".dsh-oac-discard:focus-visible,.dsh-oac-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
		].join("\n");

		/** 注入一次样式（挂到 head，带 data-plugin 便于宿主按插件生命周期清理）。 */
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-outline-styles")) return;
			const style = document.createElement("style");
			style.id = "dsh-outline-styles";
			style.setAttribute("data-plugin", "dsh-outline");
			style.setAttribute("data-plugin-css", "dsh-outline");
			style.textContent = CSS_TEXT;
			document.head.appendChild(style);
		}

		/** 极简 SnapshotStore：getSnapshot/subscribe，满足槽位渲染器的 hooks 契约。 */
		function createStore(initial) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
				set: (next) => {
					if (next === snapshot) return;
					snapshot = next;
					for (const listener of [...listeners]) listener();
				},
			};
		}

		/**
		 * 卡片表单控制器：把 settingsScope 命名空间快照投影为卡片状态，
		 * 提供 edit/resetField/save/discard/focus/remove 动作（对齐官方 CardActions）。
		 */
		function createController(scope) {
			let draft = {}; // field -> { text, clear }
			let saving = false;
			let failed = false;
			let saved = false;
			let focused = {}; // field -> boolean（apiToken 掩码的聚焦状态）
			const store = createStore(project());

			function fieldState(name) {
				const snap = scope.getSnapshot();
				const ready = snap.status === "ready";
				const value = (ready && snap.value) || {};
				const user = (ready && snap.user) || {};
				const staged = draft[name];
				const text = staged !== undefined ? staged.text : (ready ? String(value[name] ?? "") : "");
				const overridden = staged !== undefined ? !staged.clear : user[name] !== undefined;
				const configured = ready ? String(value[name] ?? "").trim() !== "" : false;
				// apiToken 掩码：已配置且未聚焦且无草稿 → 星号占位；聚焦后显示空草稿（placeholder 提示替换）。
				const display = name === "apiToken" && configured && staged === undefined
					? (focused[name] === true ? "" : MASK)
					: text;
				return { text, display, overridden, invalid: false, configured, focused: focused[name] === true };
			}

			function project() {
				const snap = scope.getSnapshot();
				const ready = snap.status === "ready";
				// 判定“已配置”用已保存的存储值（snap.value），不受未保存草稿影响：
				// baseUrl 与 apiToken 都已填写才视为已配置。
				const stored = (ready && snap.value) || {};
				const out = {
					available: ready,
					writable: snap.writable !== false,
					dirty: Object.keys(draft).length > 0,
					invalid: false,
					saving,
					failed,
					saved,
					configured: Boolean(String(stored.baseUrl ?? "").trim() && String(stored.apiToken ?? "").trim()),
				};
				for (const name of FIELDS) out[name] = fieldState(name);
				return out;
			}

			function emit() { store.set(project()); }

			scope.subscribe(() => emit());

			const clearTransient = () => { saved = false; failed = false; };

			return {
				store,
				actions: {
					edit: (name, text) => {
						draft[name] = { text, clear: text === "" };
						clearTransient();
						emit();
					},
					resetField: (name) => {
						draft[name] = { text: "", clear: true };
						clearTransient();
						emit();
					},
					focus: (name, value) => {
						focused[name] = value;
						emit();
					},
					discard: () => {
						draft = {};
						clearTransient();
						emit();
					},
					save: () => {
						if (saving) return;
						const ops = [];
						for (const name of FIELDS) {
							const staged = draft[name];
							if (staged === undefined) continue;
							if (staged.clear) ops.push({ op: "unset", path: [name] });
							else if (staged.text !== "") ops.push({ op: "set", path: [name], value: staged.text });
						}
						if (ops.length === 0) return;
						saving = true;
						failed = false;
						emit();
						const run = async () => {
							for (const op of ops) {
								if (op.op === "set") await scope.set(op.path[0], op.value);
								else await scope.unset(op.path[0]);
							}
						};
						run().then(
							() => { draft = {}; saving = false; saved = true; emit(); },
							() => { saving = false; failed = true; emit(); },
						);
					},
					remove: (name, confirmText) => {
						if (!window.confirm(confirmText)) return;
						delete draft[name];
						focused[name] = false;
						saving = true;
						failed = false;
						emit();
						scope.unset(name).then(
							() => { saving = false; saved = true; emit(); },
							() => { saving = false; failed = true; emit(); },
						);
					},
				},
			};
		}

		/** 与官方 IconChevronDownOutline14 同形的内联 chevron（避免依赖 primitives 包）。 */
		function ChevronIcon({ open }) {
			return React.createElement(
				"svg",
				{
					className: "dsh-oac-chevron" + (open ? " dsh-oac-chevronOpen" : ""),
					width: 14,
					height: 14,
					viewBox: "0 0 16 16",
					"aria-hidden": true,
				},
				React.createElement("path", {
					d: "M4 6l4 4 4-4",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
				}),
			);
		}

		/** 复刻官方 ValueField 的字段行（支持状态徽标、敏感值掩码、移除按钮）。 */
		function ValueField(props) {
			return React.createElement(
				"div", { className: "dsh-oac-field" },
				React.createElement(
					"div", { className: "dsh-oac-head" },
					React.createElement("label", { className: "dsh-oac-label", htmlFor: props.id }, props.label),
					React.createElement(
						"span", { className: "dsh-oac-badges" },
						React.createElement(
							"span", { className: "dsh-oac-badge" + (props.statusOk ? " dsh-oac-badgeOk" : ""), role: "status" },
							props.statusOk ? props.okLabel : props.noLabel,
						),
						props.overridden
							? React.createElement("span", { className: "dsh-oac-badge" }, props.overriddenLabel)
							: null,
						props.configured && !props.disabled
							? React.createElement("button", {
								type: "button",
								className: "dsh-oac-reset",
								disabled: props.disabled,
								onClick: props.onRemove,
							}, props.removeLabel)
							: null,
					),
				),
				React.createElement("input", {
					id: props.id,
					className: "dsh-oac-input",
					type: props.password ? "password" : "text",
					value: props.display,
					placeholder: props.placeholder ?? "",
					autoComplete: props.password ? "off" : undefined,
					disabled: props.disabled,
					onFocus: props.onFocus,
					onBlur: props.onBlur,
					onChange: (event) => {
						let v = event.currentTarget.value;
						if (props.password && v.startsWith(MASK)) v = v.slice(MASK.length);
						props.onEdit(v);
					},
				}),
				React.createElement("p", { className: "dsh-oac-hint" }, props.hint),
			);
		}

		/** 复刻官方 PluginCard 的卡片外壳（可折叠头部 + 字段组 + 底部操作栏）。 */
		function OutlineCard(props) {
			const [open, setOpen] = React.useState(false);
			const state = props.useOutlineAutoCard((s) => s);
			const t = props.t;
			if (!state.available) return null;
			const blocked = !state.dirty || state.invalid || state.saving;
			const title = t("cardTitle");

			return React.createElement(
				"li", { className: "dsh-oac-card" + (open ? " dsh-oac-open" : "") },
				React.createElement(
					"button",
					{
						type: "button",
						className: "dsh-oac-header",
						"aria-expanded": open,
						"aria-label": t(open ? "collapse" : "expand") + ": " + title,
						onClick: () => { setOpen(!open); },
					},
					React.createElement(
						"span", { className: "dsh-oac-headText" },
						React.createElement("span", { className: "dsh-oac-name" }, title),
						React.createElement("span", { className: "dsh-oac-description" }, t("cardDescription")),
					),
					state.configured
						? React.createElement("span", { className: "dsh-oac-badge dsh-oac-badgeOk", role: "status" }, t("configured"))
						: React.createElement("span", { className: "dsh-oac-badge", role: "status" }, t("notConfigured")),
					state.dirty ? React.createElement("span", { className: "dsh-oac-pending" }, t("unsaved")) : null,
					React.createElement(ChevronIcon, { open }),
				),
				open
					? React.createElement(
						"div", { className: "dsh-oac-body" },
						!state.writable ? React.createElement("p", { className: "dsh-oac-readOnly", role: "status" }, t("readOnly")) : null,
						React.createElement(ValueField, {
							id: "outline-auto-baseUrl",
							label: t("baseUrl"),
							hint: t("baseUrlHint"),
							statusOk: state.baseUrl.configured,
							okLabel: t("configured"),
							noLabel: t("notConfigured"),
							overriddenLabel: t("overridden"),
							removeLabel: t("removeUrl"),
							display: state.baseUrl.text,
							overridden: state.baseUrl.overridden,
							configured: state.baseUrl.configured,
							placeholder: state.baseUrl.configured ? t("keepUrlPlaceholder") : t("emptyPlaceholder"),
							disabled: !state.writable,
							onEdit: (text) => { props.edit("baseUrl", text); },
							onRemove: () => { props.remove("baseUrl", t("confirmRemoveUrl")); },
						}),
						React.createElement(ValueField, {
							id: "outline-auto-apiToken",
							label: t("apiToken"),
							hint: state.apiToken.configured ? t("tokenHintConfigured") : t("apiTokenHint"),
							statusOk: state.apiToken.configured,
							okLabel: t("configured"),
							noLabel: t("notConfigured"),
							overriddenLabel: t("overridden"),
							removeLabel: t("removeToken"),
							display: state.apiToken.display,
							overridden: state.apiToken.overridden,
							configured: state.apiToken.configured,
							placeholder: state.apiToken.configured ? t("keepTokenPlaceholder") : t("emptyPlaceholder"),
							password: true,
							disabled: !state.writable,
							onEdit: (text) => { props.edit("apiToken", text); },
							onFocus: () => { props.focus("apiToken", true); },
							onBlur: () => { props.focus("apiToken", false); },
							onRemove: () => { props.remove("apiToken", t("confirmRemoveToken")); },
						}),
						React.createElement(ValueField, {
							id: "outline-auto-writablePaths",
							label: t("writablePaths"),
							hint: t("writablePathsHint"),
							statusOk: state.writablePaths.configured,
							okLabel: t("writableMode"),
							noLabel: t("readonlyMode"),
							overriddenLabel: t("overridden"),
							removeLabel: t("removeWritable"),
							display: state.writablePaths.text,
							overridden: state.writablePaths.overridden,
							configured: state.writablePaths.configured,
							placeholder: t("emptyPlaceholder"),
							disabled: !state.writable,
							onEdit: (text) => { props.edit("writablePaths", text); },
							onRemove: () => { props.remove("writablePaths", t("confirmRemoveWritable")); },
						}),
						React.createElement(ValueField, {
							id: "outline-auto-localSaveDir",
							label: t("localSaveDir"),
							hint: t("localSaveDirHint"),
							statusOk: state.localSaveDir.configured,
							okLabel: t("configured"),
							noLabel: t("notConfigured"),
							overriddenLabel: t("overridden"),
							removeLabel: t("removeSaveDir"),
							display: state.localSaveDir.text,
							overridden: state.localSaveDir.overridden,
							configured: state.localSaveDir.configured,
							placeholder: t("emptyPlaceholder"),
							disabled: !state.writable,
							onEdit: (text) => { props.edit("localSaveDir", text); },
							onRemove: () => { props.remove("localSaveDir", t("confirmRemoveSaveDir")); },
						}),
						React.createElement(
							"div", { className: "dsh-oac-footer" },
							state.failed ? React.createElement("p", { className: "dsh-oac-failed", role: "status" }, t("saveFailed")) : null,
							state.saved && !state.dirty ? React.createElement("p", { className: "dsh-oac-msg", role: "status" }, t("saved")) : null,
							React.createElement("button", {
								type: "button",
								className: "dsh-oac-discard",
								disabled: !state.dirty || state.saving,
								onClick: props.discard,
							}, t("discard")),
							React.createElement("button", {
								type: "button",
								className: "dsh-oac-save",
								disabled: blocked,
								onClick: props.save,
							}, t(state.saving ? "saving" : "save")),
						),
					)
					: null,
			);
		}

		function tryActivate(ctx) {
			injectStyles();
			const slots = ctx.slots;
			const locale = ctx.locale;
			const settingsScope = ctx.settingsScope;
			if (slots === undefined || typeof slots.inject !== 'function'
				|| typeof slots.register !== 'function') {
				console.warn("[dsh-outline] ctx.slots unavailable; settings card not registered");
				return false;
			}
			if (locale === undefined || typeof locale.register !== 'function') {
				console.warn("[dsh-outline] ctx.locale unavailable; settings card not registered");
				return false;
			}
			if (settingsScope === undefined || typeof settingsScope.bind !== 'function') {
				console.warn("[dsh-outline] ctx.settingsScope unavailable; settings card not registered");
				return false;
			}
			try {
				ctx.effect(() => locale.register(NS, { zh, en }), "dsh-outline: settings card locale");
				const controller = createController(settingsScope.bind({ namespace: NS_KEY }));
				// keyed 槽位按 priority 升序排列（order 无效）：priority -1 使本卡片排在所有
				// 默认 priority 0 的卡片之前；使用 inject 声明式注册。
				slots.inject("settings.plugin.item", () => slots.register({
					name: "settings.plugin.item",
					key: NS_KEY,
					priority: -1,
					locale: NS,
					inject: () => ({ hooks: { outlineAutoCard: controller.store }, ...controller.actions }),
				}, OutlineCard));
				return true;
			}
			catch (err) {
				console.warn("[dsh-outline] activation failed: "
					+ (err && err.message ? err.message : err));
				return false;
			}
		}

		function apply(ctx) {
			if (tryActivate(ctx)) return;
			// DSH may defer required services; wait for service-added events so
			// the card still mounts across boot-order changes and renames.
			if (typeof ctx.on === "function") {
				ctx.on("service-added", (name) => {
					if (name === "slots" || name === "locale" || name === "settingsScope") {
						tryActivate(ctx);
					}
				});
			}
		}

		const inject = ["slots", "locale", "settingsScope"];

		exports.name = "dsh-outline";
		exports.inject = inject;
		exports.apply = apply;
		exports.internals = Object.freeze({
			OutlineCard,
			ValueField,
			createController,
			createStore,
			CSS_TEXT,
			zh,
			en,
		});
		return module.exports;
	}
});
