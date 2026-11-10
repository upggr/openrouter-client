(function () {
	'use strict';
	const vscode = acquireVsCodeApi();
	const render = window.OpenRouterMarkdown.render;
	const $ = id => document.getElementById(id);
	const transcript = $('transcript');
	const input = $('input');

	let state = {};
	let assistantEl;
	let assistantText = '';
	let renderQueued = false;
	let reasoningEl;
	let liveChars = 0;
	/** Learned $ per token per model, from completed requests this session. Used for live cost hints only. */
	const costRates = new Map();
	let setupOpen = false;
	let lastActivity = Date.now();
	let awaitingApproval = false;
	let statusTimer;
	let incantation = 0;
	// Dark sorcery waiting phrases, cycled while the agent works — a grim twist on Claude's playful verbs.
	const INCANTATIONS = [
		'Summoning the spirits', 'Consulting the void', 'Reading the runes', 'Brewing the answer',
		'Casting the incantation', 'Whispering to the machine', 'Divining the diff', 'Binding the tokens',
		'Channeling the dark arts', 'Scrying the codebase', 'Transmuting errors', 'Raising the dead code',
		'Deciphering the grimoire', 'Piercing the veil', 'Stirring the cauldron', 'Unmaking the bug',
	];
	// Tool calls for the current assistant turn, batched into one collapsible group
	// so a long run of commands does not flood the transcript.
	let activity = null;
	const tools = new Map();
	const TOOL_VERBS = { read_file: 'Read', search_text: 'Searched', list_files: 'Listed', edit_file: 'Edited', write_file: 'Wrote', run_command: 'Ran', save_memory: 'Saved memory', web_search: 'Searched the web', fetch_url: 'Fetched', spawn_agent: 'Spawned' };

	function verbFor(toolName, summary) {
		const verb = TOOL_VERBS[toolName];
		if (verb) { return verb; }
		return summary ? summary.charAt(0).toUpperCase() + summary.slice(1) : 'Tool';
	}

	function toolTarget(summary, toolName) {
		if (TOOL_VERBS[toolName]) {
			const cleaned = summary.replace(/^(Read|Searched for|Listed|Edit|Create|Ran|Save|Search|Fetch)\s+/i, '');
			return cleaned || summary;
		}
		return '';
	}

	function ensureActivity() {
		if (!activity) {
			activity = add(element('details', 'activity'));
			activity.appendChild(element('summary', '', ''));
			activity.appendChild(element('div', 'activity-list'));
			activity.open = true;
		}
		return activity;
	}

	function activitySummary() {
		if (!activity) { return; }
		const total = activity.querySelector('.activity-list').children.length;
		const running = activity.querySelectorAll('.activity-item.running').length;
		const open = activity.open;
		const summary = activity.querySelector('summary');
		summary.textContent = running > 0
			? 'Weaving… ' + (total - running + 1) + '/' + total
			: total === 1 ? '1 rite performed' : total + ' rites performed';
		if (running === 0 && open) { activity.open = false; }
	}

	function startTool(event) {
		const group = ensureActivity();
		const item = element('div', 'activity-item running');
		item.appendChild(element('span', 'verb', verbFor(event.tool, event.summary)));
		item.appendChild(element('span', 'target', toolTarget(event.summary, event.tool)));
		const output = element('pre', 'output');
		item.appendChild(output);
		group.querySelector('.activity-list').appendChild(item);
		tools.set(event.callId, item);
		activitySummary();
		scroll();
	}

	function endTool(callId, ok, output) {
		const item = tools.get(callId);
		if (item) {
			item.classList.remove('running');
			item.classList.add(ok ? 'ok' : 'failed');
			item.querySelector('.output').textContent = output;
			tools.delete(callId);
		}
		activitySummary();
	}

	// Kept in sync with src/core/attachments.ts.
	const MAX_ATTACHMENTS = 5;
	const MAX_ATTACHMENT_TEXT = 50000;
	const MAX_ATTACHMENT_IMAGE_BYTES = 8 * 1024 * 1024;
	const MAX_IMAGE_DIMENSION = 1600;
	let pendingAttachments = [];
	let screenshotCount = 0;
	// @-mention autocomplete state.
	let mention = null; // { start, query, results, index }
	let mentionRequest = 0;

	function post(type, extra) {
		vscode.postMessage(Object.assign({ type: type }, extra));
	}

	function element(tag, className, text) {
		const el = document.createElement(tag);
		if (className) { el.className = className; }
		if (text !== undefined) { el.textContent = text; }
		return el;
	}

	function scroll() {
		transcript.scrollTop = transcript.scrollHeight;
	}

	function add(el) {
		transcript.appendChild(el);
		scroll();
		return el;
	}

	function fill(select, options, value) {
		select.replaceChildren(...options.map(o => {
			const option = element('option', '', o.label);
			option.value = o.value;
			if (o.title) { option.title = o.title; }
			return option;
		}));
		select.value = value;
	}

	/** One-click choices. Drawn only from state, so a declined change (like Bypass) never looks applied. */
	function fillToggle(group, options, value) {
		const focused = group.contains(document.activeElement) ? document.activeElement.dataset.value : undefined;
		group.replaceChildren(...options.map(o => {
			const button = element('button', '', o.label);
			button.type = 'button';
			button.dataset.value = o.value;
			button.title = o.title || o.label;
			button.setAttribute('aria-pressed', String(o.value === value));
			return button;
		}));
		const restore = Array.from(group.children).find(b => b.dataset.value === focused);
		if (restore) { restore.focus(); }
	}

	function onToggle(group, type) {
		group.addEventListener('click', event => {
			const button = event.target.closest('button');
			if (button && button.getAttribute('aria-pressed') !== 'true') { post(type, { value: button.dataset.value }); }
		});
	}

	const KEY_STATUS = { ok: 'API key working', rejected: 'API key rejected', unknown: 'API key not checked yet' };

	function drawKeys(keys, status) {
		const active = keys.find(k => k.active);
		const name = !active ? 'from environment' : active.label === active.masked ? active.masked : active.label + ' · ' + active.masked;
		const health = KEY_STATUS[status] ? status : 'unknown';
		const button = $('keyButton');
		button.className = health;
		button.title = KEY_STATUS[health] + ': ' + name;
		button.setAttribute('aria-label', button.title);
		$('keyList').replaceChildren(...keys.map(key => {
			const row = element('div', key.active ? 'key-item active' : 'key-item');
			const pick = element('button', 'key-pick');
			pick.type = 'button';
			pick.setAttribute('aria-pressed', String(key.active));
			pick.appendChild(element('span', '', (key.active ? '✓ ' : '') + key.label));
			const host = key.gateway.replace(/^https?:\/\//, '');
			pick.appendChild(element('small', '', key.label === key.masked ? host : key.masked + ' · ' + host));
			pick.addEventListener('click', () => {
				if (!key.active) { post('switchKey', { value: key.id }); }
				closeKeyMenu();
			});
			row.appendChild(pick);
			const forget = element('button', 'key-forget', '×');
			forget.type = 'button';
			forget.title = key.active ? 'Forget this key. OpenRouter Client moves to another saved key, or asks for a new one.' : 'Forget this key';
			forget.setAttribute('aria-label', 'Forget ' + key.label);
			forget.addEventListener('click', () => {
				if (forget.classList.contains('armed')) { post('forgetKey', { value: key.id }); return; }
				forget.classList.add('armed');
				forget.textContent = 'Forget?';
			});
			row.appendChild(forget);
			return row;
		}));
	}

	function showKeyForm(open) {
		$('keyForm').hidden = !open;
		$('addKey').hidden = open;
		$('keyError').hidden = true;
		$('newKey').value = '';
		$('newKeyName').value = '';
		if (open) {
			$('newKeyGateway').value = state.gateway || '';
			$('newKey').focus();
		}
	}

	function openKeyMenu(withForm) {
		$('keyMenu').hidden = false;
		$('keyButton').setAttribute('aria-expanded', 'true');
		showKeyForm(withForm);
	}

	function closeKeyMenu() {
		$('keyMenu').hidden = true;
		$('keyButton').setAttribute('aria-expanded', 'false');
		showKeyForm(false);
	}

	function saveKey() {
		$('keyError').hidden = true;
		$('saveKey').disabled = true;
		post('addKey', { gateway: $('newKeyGateway').value.trim(), key: $('newKey').value.trim(), label: $('newKeyName').value.trim() });
	}

	function endAssistant() {
		if (assistantEl) { assistantEl.innerHTML = render(assistantText); }
		assistantEl = undefined;
		assistantText = '';
		if (reasoningEl) {
			const box = reasoningEl.closest('details');
			if (box) {
				box.open = false;
				const tokens = Math.ceil(reasoningEl.textContent.length / 4).toLocaleString();
				box.querySelector('summary').textContent = 'Thought for ~' + tokens + ' tokens';
			}
		}
		reasoningEl = undefined;
	}

	function appendAssistant(text) {
		if (!assistantEl) { assistantEl = add(element('div', 'message assistant')); }
		assistantText += text;
		if (!renderQueued) {
			renderQueued = true;
			requestAnimationFrame(() => {
				renderQueued = false;
				if (assistantEl) {
					assistantEl.innerHTML = render(assistantText);
					scroll();
				}
			});
		}
	}

	function toolCard(summary, output) {
		// Used only for restoring a saved chat: one collapsed details card per tool.
		const card = element('details', 'tool');
		card.appendChild(element('summary', '', summary));
		card.appendChild(element('pre', 'output')).textContent = output;
		return card;
	}

	function showPermission(event) {
		// Approvals stand out on their own card (like Claude), not buried inside a tool pill.
		const box = add(element('div', 'permission-card'));
		box.dataset.callId = event.callId;
		box.appendChild(element('div', 'perm-title', verbFor(event.tool, event.summary) + ' ' + toolTarget(event.summary, event.tool)));
		if (event.sensitive) { box.appendChild(element('p', 'warning', 'This touches a sensitive file or a location that can run code.')); }
		if (event.detail) { box.appendChild(element('code', 'command', event.detail)); }
		const buttons = element('div', 'row');
		const answer = value => { box.remove(); post('permission', { id: event.callId, answer: value }); };
		if (event.canDiff) {
			const diff = element('button', 'secondary', 'View diff');
			diff.type = 'button';
			diff.addEventListener('click', () => post('openDiff', { id: event.callId }));
			buttons.appendChild(diff);
		}
		// Sensitive actions are never remembered, so "Always" is not offered for them.
		[['Allow', 'allow', ''], ['Always', 'always', 'secondary'], ['Deny', 'deny', 'secondary']].filter(choice => !(event.sensitive && choice[1] === 'always')).forEach(([label, value, cls]) => {
			const button = element('button', cls, label);
			button.type = 'button';
			button.dataset.answer = value;
			button.addEventListener('click', () => answer(value));
			buttons.appendChild(button);
		});
		box.appendChild(buttons);
		scroll();
	}

	function showError(message, showBuy) {
		const box = add(element('div', 'message error', message));
		const retry = element('button', 'secondary', 'Retry');
		retry.type = 'button';
		retry.addEventListener('click', () => { box.remove(); post('retry'); });
		box.appendChild(retry);
		if (showBuy) {
			const button = element('button', 'secondary', 'Get an API key');
			button.type = 'button';
			button.addEventListener('click', () => post('buy'));
			box.appendChild(button);
		}
	}

	function showSuggestions(list) {
		const bar = $('suggestions');
		bar.replaceChildren();
		bar.hidden = list.length === 0;
		list.forEach(text => {
			const chip = element('button', 'suggestion-chip', text);
			chip.type = 'button';
			chip.addEventListener('click', () => {
				bar.hidden = true;
				input.value = text;
				send();
			});
			bar.appendChild(chip);
		});
	}

	function showRewind(rewind) {
		const box = add(element('div', 'rewind-card'));
		box.appendChild(element('span', 'muted', 'Edited ' + rewind.count + ' file' + (rewind.count === 1 ? '' : 's')));
		const list = element('span', 'rewind-files', rewind.paths.slice(0, 4).join(', ') + (rewind.paths.length > 4 ? '…' : ''));
		list.title = rewind.paths.join('\n');
		box.appendChild(list);
		const button = element('button', 'secondary', '⟲ Rewind');
		button.type = 'button';
		button.title = 'Restore these files to before this turn';
		button.addEventListener('click', () => { box.remove(); post('rewind'); });
		box.appendChild(button);
		scroll();
	}

	function renderStatus() {
		const status = $('status');
		status.hidden = !state.busy;
		if (!state.busy) { return; }
		const seconds = Math.floor((Date.now() - lastActivity) / 1000);
		const queued = state.queue && state.queue.length ? ' · ' + state.queue.length + ' queued' : '';
		let base;
		if (awaitingApproval) { base = '⚠ Awaiting your blessing (approval)'; }
		else if (liveChars) {
			// Tokens are arriving, so report the pause since the last one, not a dead stream.
			base = seconds > 3 ? INCANTATIONS[incantation] + '… · ' + seconds + 's since last token' : INCANTATIONS[incantation] + '…';
		}
		else { base = seconds < 30 ? INCANTATIONS[incantation] + '… ' + seconds + 's' : 'The spirits are silent (' + seconds + 's) — press Stop to break the spell'; }
		const liveTokens = Math.ceil(liveChars / 4);
		const rate = costRates.get(state.liveModel || state.model);
		const estimate = liveChars && rate ? ' (~$' + (liveTokens * rate).toFixed(6) + ')' : '';
		const live = liveChars ? ' · ~' + liveTokens.toLocaleString() + ' tokens out' + estimate : '';
		status.textContent = base + live + queued;
	}

	function updateStatusTimer() {
		if (state.busy && !statusTimer) {
			lastActivity = Date.now();
			incantation = Math.floor(Math.random() * INCANTATIONS.length);
			statusTimer = setInterval(() => {
				// Drift to a new dark phrase every few seconds while it works.
				if (Math.floor((Date.now() - lastActivity) / 1000) % 4 === 0 && Math.random() < 0.3) {
					incantation = (incantation + 1) % INCANTATIONS.length;
				}
				renderStatus();
			}, 1000);
		} else if (!state.busy && statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
			awaitingApproval = false;
		}
		renderStatus();
	}

	function onEvent(event) {
		lastActivity = Date.now();
		if (event.type === 'permission') { awaitingApproval = true; }
		if (event.type === 'toolEnd') { awaitingApproval = false; }
		renderStatus();
		switch (event.type) {
			case 'user': {
				state.routedModels = [];
				state.liveModel = undefined;
				drawModel();
				endAssistant();
				activity = null;
				liveChars = 0;
				closeMentions();
				$('suggestions').hidden = true;
				const box = add(element('div', 'message user', event.text));
				(event.mentions || []).forEach(m => { box.appendChild(element('span', 'chip mention-chip', '@' + m)); });
				(event.attachments || []).forEach(a => {
					if (a.isImage && a.dataUrl) {
						const img = element('img', 'thumb');
						img.src = a.dataUrl;
						img.alt = a.name;
						img.title = a.name;
						box.appendChild(img);
					} else {
						box.appendChild(element('span', 'chip', (a.isImage ? '🖼 ' : '📄 ') + a.name));
					}
				});
				break;
			}
			case 'text':
				liveChars += event.text.length;
				lastActivity = Date.now();
				appendAssistant(event.text);
				break;
			case 'reasoning':
				liveChars += event.text.length;
				lastActivity = Date.now();
				if (!reasoningEl) {
					const box = add(element('details', 'reasoning'));
					box.appendChild(element('summary', '', 'Thinking…'));
					reasoningEl = box.appendChild(element('div', 'output'));
				}
				reasoningEl.textContent += event.text;
				reasoningEl.parentElement.querySelector('summary').textContent = 'Thinking… ~' + Math.ceil(liveChars / 4).toLocaleString() + ' tokens';
				break;
			case 'toolStart': {
				endAssistant();
				startTool(event);
				break;
			}
			case 'permission':
				showPermission(event);
				break;
			case 'toolEnd':
				endTool(event.callId, event.ok, event.output);
				break;
			case 'routedModel':
				reportRoutedModel(event.model);
				break;
			case 'usage': {
				reportRoutedModel(event.usage.model);
				const total = (event.usage.promptTokens || 0) + (event.usage.completionTokens || 0);
				if (event.usage.cost && total > 0) { costRates.set(event.usage.model || state.model, event.usage.cost / total); }
				showContext(event.usage);
				break;
			}
			case 'notice':
				endAssistant();
				add(element('div', 'message notice', event.message));
				break;
			case 'info': {
				endAssistant();
				const info = add(element('div', 'message notice'));
				info.innerHTML = render(event.text);
				break;
			}
			case 'error':
				endAssistant();
				showError(event.message, event.showBuy);
				break;
			case 'done':
				endAssistant();
				if (event.rewind && event.rewind.count > 0) { showRewind(event.rewind); }
				break;
			default:
				break;
		}
		// Render again after the switch: text and reasoning events grow the live token count.
		renderStatus();
	}

	function isImage(file) {
		return file.type.indexOf('image/') === 0;
	}

	function isLikelyText(file) {
		if (isImage(file)) { return false; }
		if (file.type && file.type.indexOf('text/') === 0) { return true; }
		return /\.(txt|md|markdown|json|jsonc|ya?ml|csv|tsv|log|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|toml|ini|env|gitignore|dockerfile)$/i.test(file.name);
	}

	function downscaleImage(file) {
		return new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = () => {
				const img = new Image();
				img.onload = () => {
					const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height));
					const canvas = document.createElement('canvas');
					canvas.width = Math.max(1, Math.round(img.width * scale));
					canvas.height = Math.max(1, Math.round(img.height * scale));
					const ctx = canvas.getContext('2d');
					ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
					resolve(canvas.toDataURL('image/png'));
				};
				img.onerror = () => resolve(reader.result);
				img.src = reader.result;
			};
			reader.onerror = () => resolve(undefined);
			reader.readAsDataURL(file);
		});
	}

	function readText(file) {
		return new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = () => {
				const text = String(reader.result || '');
				resolve({ text: text.slice(0, MAX_ATTACHMENT_TEXT), truncated: text.length > MAX_ATTACHMENT_TEXT });
			};
			reader.onerror = () => resolve({ text: '[Could not read this file.]', truncated: false });
			reader.readAsText(file);
		});
	}

	async function addFiles(files) {
		const list = Array.from(files || []);
		for (const file of list) {
			if (pendingAttachments.length >= MAX_ATTACHMENTS) {
				add(element('div', 'message notice', 'Only ' + MAX_ATTACHMENTS + ' attachments are kept at a time.'));
				break;
			}
			if (isImage(file)) {
				if (file.size > MAX_ATTACHMENT_IMAGE_BYTES) {
					add(element('div', 'message notice', file.name + ' is too large to attach.'));
					continue;
				}
				const dataUrl = await downscaleImage(file);
				if (dataUrl) {
					screenshotCount += 1;
					pendingAttachments.push({ name: file.name || ('screenshot-' + screenshotCount + '.png'), mime: 'image/png', dataUrl: dataUrl });
				}
			} else if (isLikelyText(file)) {
				const result = await readText(file);
				pendingAttachments.push({ name: file.name, mime: file.type || 'text/plain', text: result.text, truncated: result.truncated });
			} else {
				add(element('div', 'message notice', file.name + ' is a type OpenRouter Client cannot read yet. Attach a text file or an image.'));
			}
		}
		renderAttachments();
	}

	function removeAttachment(index) {
		pendingAttachments.splice(index, 1);
		renderAttachments();
	}

	function renderAttachments() {
		const bar = $('attachments');
		bar.replaceChildren();
		bar.hidden = pendingAttachments.length === 0;
		pendingAttachments.forEach((attachment, index) => {
			const chip = element('span', 'chip', (attachment.dataUrl ? '🖼 ' : '📄 ') + attachment.name);
			const remove = element('button', 'link', '×');
			remove.type = 'button';
			remove.title = 'Remove';
			remove.addEventListener('click', () => removeAttachment(index));
			chip.appendChild(remove);
			bar.appendChild(chip);
		});
	}

	function showContext(usage) {
		const tokens = typeof usage === 'number' ? usage : usage && usage.promptTokens;
		const model = (state.models || []).find(m => m.id === state.model);
		const meter = $('contextUsage');
		meter.textContent = tokens && model ? Math.min(100, Math.round(tokens / model.contextWindow * 100)) + '% context' : '';
		if (!tokens || !model) { meter.title = ''; return; }
		const parts = [tokens.toLocaleString() + ' of ' + model.contextWindow.toLocaleString() + ' prompt tokens'];
		if (usage.cachedTokens) { parts.push(usage.cachedTokens.toLocaleString() + ' from cache'); }
		if (usage.cacheWriteTokens) { parts.push(usage.cacheWriteTokens.toLocaleString() + ' written to cache'); }
		if (usage.reasoningTokens) { parts.push(usage.reasoningTokens.toLocaleString() + ' reasoning'); }
		if (usage.cost) { parts.push('cost $' + (usage.cost < 0.01 ? usage.cost.toFixed(6) : usage.cost.toFixed(4))); }
		meter.title = parts.join(', ');
	}

	function drawModel() {
		const selected = (state.models || []).find(m => m.id === state.model);
		const auto = state.model === 'auto' || state.model === 'openrouter/auto';
		const routed = auto ? (state.routedModels || []) : [];
		const names = routed.map(id => {
			const model = (state.models || []).find(m => m.id === id);
			return model ? model.name : id;
		});
		const label = auto ? 'Auto' : (selected && selected.deprecated ? '⚠ ' : '') + (selected ? selected.name : state.model);
		const text = label + (names.length ? ' · ' + names.join(', ') : '');
		$('modelName').textContent = text;
		$('model').title = 'Choose model · ' + state.model + (routed.length ? '\nRouted to: ' + routed.join(', ') : '');
		$('model').setAttribute('aria-label', 'Choose model: ' + text);
	}

	function drawEconomy() {
		const button = $('economy');
		const on = !!state.economy;
		button.setAttribute('aria-pressed', on ? 'true' : 'false');
		// The saving is only meaningful once something has actually run on the cheap model.
		const savings = on ? state.savings : undefined;
		$('savings').textContent = savings ? savings.label : 'Economy';
		button.title = savings
			? savings.detail
			: on
				? 'Economy mode is on: summaries, follow-up suggestions and read-only sub-agents run on a cheaper model. Click to turn off.'
				: 'Economy mode: run summaries, follow-up suggestions and read-only sub-agents on a cheaper model. Your replies and file edits stay on the model you picked.';
	}

	function reportRoutedModel(model) {
		if (!model || model === 'auto' || model === 'openrouter/auto') { return; }
		state.routedModels = state.routedModels || [];
		if (!state.routedModels.includes(model)) { state.routedModels.push(model); }
		state.liveModel = model;
		drawModel();
	}

	function applyState(next) {
		state = { ...next, routedModels: [...(next.routedModels || [])] };
		state.liveModel = state.routedModels.at(-1);
		if (!next.hasKey || setupOpen) {
			if (!$('gateway').value) { $('gateway').value = next.gateway; }
		}
		showSetup(!next.hasKey || setupOpen);
		if (!next.hasKey) { closeKeyMenu(); return; }

		const models = next.models.length ? next.models : [{ id: next.model, name: next.model, efforts: [] }];
		drawModel();
		drawEconomy();
		$('includeSelection').checked = next.includeSelection !== false;
		fillToggle($('mode'), next.modes.map(m => ({ value: m.id, label: m.short || m.label, title: m.label + ': ' + m.detail })), next.mode);
		$('mode').classList.toggle('danger', next.mode === 'bypassPermissions');
		drawKeys(next.keys || [], next.keyStatus);

		// Quiet badges on the collapsed Options row, so non-default choices are visible without the clutter.
		const activeMode = next.modes.find(m => m.id === next.mode);
		const modeBadge = $('modeBadge');
		modeBadge.textContent = activeMode ? (activeMode.short || activeMode.label) : '';
		modeBadge.hidden = next.mode === 'default';
		modeBadge.className = 'chip' + (next.mode === 'bypassPermissions' ? ' danger' : next.mode !== 'default' ? ' warn' : '');

		const current = models.find(m => m.id === next.model);
		const efforts = current ? current.efforts : [];
		$('effortWrap').hidden = efforts.length === 0;
		fillToggle($('effort'), [{ value: '', label: 'Default', title: 'Default reasoning effort' }].concat(efforts.map(e => ({ value: e, label: e, title: 'Reasoning effort: ' + e }))), efforts.includes(next.effort) ? next.effort : '');
		const effortBadge = $('effortBadge');
		effortBadge.textContent = next.effort || '';
		effortBadge.hidden = !next.effort;

		const sessions = next.sessions.slice();
		if (!sessions.some(s => s.id === next.sessionId)) { sessions.unshift({ id: next.sessionId, title: 'New chat' }); }
		fill($('sessions'), sessions.map(s => ({ value: s.id, label: s.title })), next.sessionId);

		updateStatusTimer();
		$('send').hidden = false;
		$('stop').hidden = !next.busy;
		const queueBar = $('queue');
		queueBar.replaceChildren();
		queueBar.hidden = !next.queue || next.queue.length === 0;
		(next.queue || []).forEach(item => {
			const chip = element('span', 'chip queue-chip');
			chip.appendChild(document.createTextNode('⏳ ' + item.text.slice(0, 60)));
			const now = element('button', 'link queue-now', '↯');
			now.type = 'button';
			now.title = 'Interrupt the current run and send this now';
			now.addEventListener('click', () => post('interruptSend', { id: String(item.index), text: item.text, includeSelection: false, attachments: [] }));
			chip.appendChild(now);
			const remove = element('button', 'link', '×');
			remove.type = 'button';
			remove.title = 'Remove from queue';
			remove.addEventListener('click', () => post('removeQueued', { id: String(item.index) }));
			chip.appendChild(remove);
			queueBar.appendChild(chip);
		});
		const creditsChip = $('credits');
		creditsChip.textContent = next.credits.label;
		creditsChip.className = 'chip credits-chip ' + next.credits.level;
		creditsChip.title = next.credits.detail;
		const creditsDetail = $('creditsDetail');
		creditsDetail.textContent = next.credits.label;
		creditsDetail.title = next.credits.detail;
		creditsDetail.className = 'link ' + next.credits.level;
		$('selectionChip').hidden = !next.selection;
		if (next.selection) { $('selectionText').textContent = next.selection.file + ':' + next.selection.lines; }
		showContext(next.promptTokens);
	}

	function drawTranscript(items) {
		endAssistant();
		tools.clear();
		activity = null;
		transcript.replaceChildren();
		items.forEach(item => {
			if (item.kind === 'user') {
				const box = add(element('div', 'message user', item.text));
				if (item.imageUrl) {
					const img = element('img', 'thumb');
					img.src = item.imageUrl;
					img.alt = 'Attached image';
					box.appendChild(img);
				}
			} else if (item.kind === 'notice') {
				add(element('div', 'message notice', item.text));
			} else if (item.kind === 'assistant') {
				add(element('div', 'message assistant')).innerHTML = render(item.text);
			} else {
				// Restored chat: collapse each tool back into a compact group, not a wall of boxes.
				const group = ensureActivity();
				const entry = element('div', 'activity-item ' + (item.ok ? 'ok' : 'failed'));
				entry.appendChild(element('span', 'verb', item.summary));
				entry.appendChild(element('pre', 'output')).textContent = item.output;
				group.querySelector('.activity-list').appendChild(entry);
			}
		});
		if (activity) { activity.open = false; activitySummary(); activity = null; }
	}

	function showSetup(open) {
		$('welcome').hidden = !open;
		$('app').hidden = open;
		$('closeSetup').hidden = !state.hasKey;
	}

	function saveConnection() {
		$('setupError').hidden = true;
		$('saveConnection').disabled = true;
		post('saveConnection', { gateway: $('gateway').value.trim(), key: $('apiKey').value.trim(), label: ($('keyLabel') ? $('keyLabel').value : '').trim() });
	}

	function closeMentions() {
		mention = null;
		$('mentionMenu').hidden = true;
	}

	function detectMention() {
		const pos = input.selectionStart;
		const before = input.value.slice(0, pos);
		const match = before.match(/@([\w./-]*)$/);
		if (!match) { closeMentions(); return; }
		const start = pos - match[0].length;
		// Only trigger when @ starts a token (beginning or after whitespace).
		if (start > 0 && !/\s/.test(input.value[start - 1])) { closeMentions(); return; }
		mention = { start: start, query: match[1], results: [], index: 0 };
		const requestId = ++mentionRequest;
		post('searchFiles', { id: String(requestId), value: mention.query });
	}

	function showMentions(results) {
		if (!mention) { return; }
		const menu = $('mentionMenu');
		menu.replaceChildren();
		if (results.length === 0) { menu.hidden = true; return; }
		mention.results = results;
		mention.index = 0;
		results.forEach((file, i) => {
			const item = element('div', 'mention-item' + (i === 0 ? ' active' : ''), file.path);
			item.setAttribute('role', 'option');
			item.addEventListener('mousedown', e => { e.preventDefault(); pickMention(i); });
			menu.appendChild(item);
		});
		menu.hidden = false;
	}

	function moveMention(delta) {
		if (!mention || mention.results.length === 0) { return false; }
		mention.index = (mention.index + delta + mention.results.length) % mention.results.length;
		$('mentionMenu').querySelectorAll('.mention-item').forEach((el, i) => el.classList.toggle('active', i === mention.index));
		return true;
	}

	function pickMention(index) {
		if (!mention || !mention.results.length) { return; }
		const chosen = mention.results[index !== undefined ? index : mention.index];
		const after = input.value.slice(input.selectionStart);
		input.value = input.value.slice(0, mention.start) + '@' + chosen.path + ' ' + after;
		const caret = mention.start + chosen.path.length + 2;
		input.setSelectionRange(caret, caret);
		closeMentions();
		input.focus();
	}

	function sendNow() {
		const text = input.value.trim();
		if (!text && pendingAttachments.length === 0) { return; }
		const attachments = pendingAttachments;
		pendingAttachments = [];
		renderAttachments();
		input.value = '';
		closeMentions();
		post('interruptSend', { text: text, includeSelection: !$('selectionChip').hidden && $('includeSelection').checked, attachments: attachments });
	}

	function send() {
		const text = input.value.trim();
		if (!text && pendingAttachments.length === 0) { return; }
		input.value = '';
		const attachments = pendingAttachments;
		pendingAttachments = [];
		renderAttachments();
		post('send', { text: text, includeSelection: !$('selectionChip').hidden && $('includeSelection').checked, attachments: attachments });
	}

	input.addEventListener('input', detectMention);
	input.addEventListener('click', () => { if (mention) { detectMention(); } });
	input.addEventListener('keydown', event => {
		if (mention && !$('mentionMenu').hidden) {
			if (event.key === 'ArrowDown') { event.preventDefault(); moveMention(1); return; }
			if (event.key === 'ArrowUp') { event.preventDefault(); moveMention(-1); return; }
			if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); pickMention(); return; }
			if (event.key === 'Escape') { event.preventDefault(); closeMentions(); return; }
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			// Cmd/Ctrl+Enter while the agent is busy interrupts it and sends right away.
			if (state.busy && (event.metaKey || event.ctrlKey)) { sendNow(); }
			else { send(); }
		}
		if (event.key === 'Escape' && !mention) { closeMentions(); }
	});
	$('send').addEventListener('click', send);
	$('stop').addEventListener('click', () => post('stop', { value: 'all' }));
	$('newChat').addEventListener('click', () => post('newChat'));
	$('saveConnection').addEventListener('click', saveConnection);
	$('apiKey').addEventListener('keydown', event => { if (event.key === 'Enter') { saveConnection(); } });
	$('closeSetup').addEventListener('click', () => { setupOpen = false; showSetup(false); });
	$('getSubscription').addEventListener('click', () => post('buy'));
	$('credits').addEventListener('click', () => { $('advanced').open = true; post('credits'); });
	$('creditsDetail').addEventListener('click', () => post('credits'));
	$('model').addEventListener('click', () => post('pickModel'));
	$('economy').addEventListener('click', () => post('setEconomy', { value: state.economy ? 'false' : 'true' }));
	$('includeSelection').addEventListener('change', e => post('setIncludeSelection', { value: String(e.target.checked) }));
	onToggle($('effort'), 'setEffort');
	onToggle($('mode'), 'setMode');
	$('keyButton').addEventListener('click', () => { if ($('keyMenu').hidden) { openKeyMenu(false); } else { closeKeyMenu(); } });
	$('addKey').addEventListener('click', () => showKeyForm(true));
	$('cancelKey').addEventListener('click', () => showKeyForm(false));
	$('saveKey').addEventListener('click', saveKey);
	['newKey', 'newKeyName', 'newKeyGateway'].forEach(id => $(id).addEventListener('keydown', event => { if (event.key === 'Enter') { saveKey(); } }));
	$('keyPicker').addEventListener('keydown', event => { if (event.key === 'Escape') { closeKeyMenu(); $('keyButton').focus(); } });
	document.addEventListener('click', event => { if (!$('keyMenu').hidden && !$('keyPicker').contains(event.target)) { closeKeyMenu(); } });
	$('sessions').addEventListener('change', e => post('loadSession', { value: e.target.value }));
	$('attach').addEventListener('click', () => $('fileInput').click());
	$('fileInput').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
	setupDictation();

	function setupDictation() {
		const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SpeechRecognition) { return; }
		const button = $('dictate');
		button.hidden = false;
		let recognition;
		let listening = false;
		let baseText = '';
		button.addEventListener('click', () => {
			if (listening) { recognition.stop(); return; }
			recognition = new SpeechRecognition();
			recognition.continuous = true;
			recognition.interimResults = true;
			baseText = input.value ? input.value.replace(/\s?$/, ' ') : '';
			recognition.onresult = event => {
				let text = '';
				for (let i = 0; i < event.results.length; i++) { text += event.results[i][0].transcript; }
				input.value = baseText + text;
			};
			recognition.onend = () => { listening = false; button.classList.remove('recording'); input.focus(); };
			recognition.onerror = () => { listening = false; button.classList.remove('recording'); };
			try {
				recognition.start();
				listening = true;
				button.classList.add('recording');
			} catch { /* already started */ }
		});
	}
	input.addEventListener('paste', event => {
		const files = Array.from(event.clipboardData && event.clipboardData.files || []);
		if (files.length) { event.preventDefault(); addFiles(files); }
	});
	['dragenter', 'dragover'].forEach(name => {
		document.body.addEventListener(name, event => { event.preventDefault(); document.body.classList.add('dragging'); });
	});
	['dragleave', 'drop'].forEach(name => {
		document.body.addEventListener(name, event => { event.preventDefault(); document.body.classList.remove('dragging'); });
	});
	document.body.addEventListener('drop', event => {
		const files = event.dataTransfer && event.dataTransfer.files;
		if (files && files.length) { addFiles(files); }
	});
	transcript.addEventListener('click', event => {
		if (event.target.classList.contains('copy')) {
			const code = event.target.parentElement.querySelector('code').textContent;
			navigator.clipboard.writeText(code).then(() => { event.target.textContent = 'Copied'; });
		}
	});

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'state') { applyState(message); }
		else if (message.type === 'transcript') { drawTranscript(message.items); }
		else if (message.type === 'event') { onEvent(message.event); }
		else if (message.type === 'showSetup') { setupOpen = true; $('gateway').value = state.gateway || ''; showSetup(true); $('apiKey').focus(); }
		else if (message.type === 'setupResult') {
			$('saveConnection').disabled = false;
			$('setupError').textContent = message.error || '';
			$('setupError').hidden = !message.error;
			if (!message.error) { $('apiKey').value = ''; setupOpen = false; showSetup(!state.hasKey); }
		}
		else if (message.type === 'keyResult') {
			$('saveKey').disabled = false;
			$('keyError').textContent = message.error || '';
			$('keyError').hidden = !message.error;
			if (!message.error) { closeKeyMenu(); }
		}
		else if (message.type === 'fileResults') {
			// Only honor the latest search, so fast typing doesn't show stale results.
			if (mention && Number(message.id) === mentionRequest) { showMentions(message.results || []); }
		}
		else if (message.type === 'suggestions') { showSuggestions(message.suggestions || []); }
		else if (message.type === 'focusInput') { input.value = message.text || ''; input.focus(); }
	});

	post('ready');
	// After a VS Code reload the webview can be re-created without new state arriving; ask again
	// whenever the panel becomes visible so it never sits empty and looks stuck.
	document.addEventListener('visibilitychange', () => { if (!document.hidden) { post('ready'); } });
})();
