// Small Markdown renderer. All text is HTML-escaped before any formatting is applied.
(function (root) {
	'use strict';

	function escapeHtml(text) {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	function inline(text) {
		const codes = [];
		let out = escapeHtml(text).replace(/`([^`]+)`/g, function (_, code) {
			codes.push(code);
			return '\u0000' + (codes.length - 1) + '\u0000';
		});
		out = out
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
			.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
		return out.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + codes[Number(i)] + '</code>'; });
	}

	function tableRow(line, tag) {
		const cells = line.trim().replace(/^\||\|$/g, '').split('|');
		return '<tr>' + cells.map(function (c) { return '<' + tag + '>' + inline(c.trim()) + '</' + tag + '>'; }).join('') + '</tr>';
	}

	function render(markdown) {
		const lines = String(markdown).split('\n');
		const html = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			const fence = line.match(/^\s*```\s*([\w+-]*)/);
			if (fence) {
				const code = [];
				i++;
				while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i++]); }
				i++;
				html.push('<div class="code"><button class="copy" type="button">Copy</button><pre><code>' + escapeHtml(code.join('\n')) + '</code></pre></div>');
				continue;
			}
			const heading = line.match(/^(#{1,4})\s+(.*)/);
			if (heading) {
				const level = heading[1].length + 2;
				html.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
				i++;
				continue;
			}
			if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
				const rows = ['<thead>' + tableRow(line, 'th') + '</thead>'];
				i += 2;
				while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(tableRow(lines[i++], 'td')); }
				html.push('<table>' + rows.join('') + '</table>');
				continue;
			}
			const list = line.match(/^\s*([-*+]|\d+\.)\s+/);
			if (list) {
				const tag = /\d/.test(list[1]) ? 'ol' : 'ul';
				const items = [];
				while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
					items.push('<li>' + inline(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, '')) + '</li>');
				}
				html.push('<' + tag + '>' + items.join('') + '</' + tag + '>');
				continue;
			}
			if (/^>\s?/.test(line)) {
				const quote = [];
				while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(inline(lines[i++].replace(/^>\s?/, ''))); }
				html.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
				continue;
			}
			if (!line.trim()) { i++; continue; }
			const paragraph = [];
			while (i < lines.length && lines[i].trim() && !/^\s*```|^#{1,4}\s|^>\s?|^\s*([-*+]|\d+\.)\s+/.test(lines[i])) { paragraph.push(inline(lines[i++])); }
			if (paragraph.length === 0) { paragraph.push(inline(lines[i++])); }
			html.push('<p>' + paragraph.join('<br>') + '</p>');
		}
		return html.join('');
	}

	if (typeof module !== 'undefined' && module.exports) { module.exports = { render: render, escapeHtml: escapeHtml }; }
	else { root.OpenRouterMarkdown = { render: render, escapeHtml: escapeHtml }; }
})(typeof window !== 'undefined' ? window : globalThis);
