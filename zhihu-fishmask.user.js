// ==UserScript==
// @name         zhihu-fishmask
// @name:zh-CN   知乎摸鱼伪装
// @namespace    https://github.com/Bkyaro/zhihu-fishmask
// @version      1.0.0
// @description  把知乎伪装成 VS Code Dark+ 编辑器：问题/回答页、专栏文章、首页推荐流（git log 风格），支持老板键
// @description:en  Disguise Zhihu as a VS Code Dark+ editor — questions, answers, column posts and the home feed.
// @author       Jackal
// @license      MIT
// @homepageURL  https://github.com/Bkyaro/zhihu-fishmask
// @supportURL   https://github.com/Bkyaro/zhihu-fishmask/issues
// @match        https://www.zhihu.com/
// @match        https://www.zhihu.com/question/*
// @match        https://www.zhihu.com/answer/*
// @match        https://zhuanlan.zhihu.com/p/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/Bkyaro/zhihu-fishmask/main/zhihu-fishmask.user.js
// @updateURL    https://raw.githubusercontent.com/Bkyaro/zhihu-fishmask/main/zhihu-fishmask.user.js
// ==/UserScript==

(function () {
	"use strict";

	/* ================================================================
	 * zhihu-fishmask — 知乎 → VS Code Dark+ 伪装层
	 *
	 * 用法（速查）:
	 *   Ctrl+` 或 双击 Esc    切换伪装 / 原生知乎（老板键）
	 *   点红绿灯 / 标签页 ×    同上（隐藏伪装）
	 *   滚动到编辑区底部       自动触发知乎加载更多回答
	 *   点击正文链接/图片      照常跳转（只做渲染，不拦截请求）
	 * ================================================================ */

	const INLINE = new Set([
		"SPAN",
		"A",
		"STRONG",
		"B",
		"EM",
		"I",
		"CODE",
		"DEL",
		"S",
		"U",
		"BR",
		"IMG",
		"MARK",
		"SUP",
		"SUB",
	]);
	const SKIP = new Set([
		"SCRIPT",
		"STYLE",
		"NOSCRIPT",
		"IFRAME",
		"BUTTON",
		"SVG",
		"PATH",
		"FIGCAPTION",
	]);

	const state = {
		host: null,
		shadow: null,
		active: false,
		records: new WeakMap(),
		expanded: new WeakSet(),
		totalLines: 0,
		seq: 0,
		lastEsc: 0,
		savedTitle: "",
		obsTimer: 0,
		observer: null,
		mode: "",
	};

	/* ---------------- DOM helpers ---------------- */

	function qs(root, ...sels) {
		for (const s of sels) {
			const el = root.querySelector(s);
			if (el) return el;
		}
		return null;
	}

	function qsa(root, ...sels) {
		for (const s of sels) {
			const els = root.querySelectorAll(s);
			if (els.length) return Array.from(els);
		}
		return [];
	}

	/* ---------------- sanitizer / row builder ---------------- */

	function cloneInline(node) {
		if (node.nodeType === 3) return document.createTextNode(node.nodeValue);
		if (node.nodeType !== 1) return null;
		const tag = node.tagName;
		if (SKIP.has(tag)) return null;
		if (tag === "BR") return document.createElement("br");
		const el = document.createElement(tag === "A" ? "a" : "span");
		let cls = "";
		switch (tag) {
			case "STRONG":
			case "B":
				cls = "kw";
				break;
			case "EM":
			case "I":
				cls = "var";
				break;
			case "CODE":
				cls = "str";
				break;
			case "DEL":
			case "S":
				cls = "cmt";
				break;
			case "A": {
				cls = "fn";
				const href = node.getAttribute("href") || "";
				if (href && !/^\s*javascript:/i.test(href)) {
					el.setAttribute("href", href);
					el.setAttribute("target", "_blank");
					el.setAttribute("rel", "noopener noreferrer");
				}
				break;
			}
			default:
				cls = "";
		}
		if (cls) el.className = cls;
		for (const child of node.childNodes) {
			const c = cloneInline(child);
			if (c) el.appendChild(c);
		}
		return el;
	}

	function makeRowFromText(text, cls) {
		const row = document.createElement("div");
		row.className = "line" + (cls ? " " + cls : "");
		const tx = document.createElement("span");
		tx.className = "tx";
		tx.textContent = text;
		row.appendChild(tx);
		return row;
	}

	function makeRowFromEl(el, cls) {
		const row = document.createElement("div");
		row.className = "line" + (cls ? " " + cls : "");
		const tx = document.createElement("span");
		tx.className = "tx";
		for (const child of el.childNodes) {
			const c = cloneInline(child);
			if (c) tx.appendChild(c);
		}
		row.appendChild(tx);
		return row;
	}

	function emptyRow() {
		return makeRowFromText("", "");
	}

	function imageRow(img) {
		const src =
			img.getAttribute("data-actualsrc") ||
			img.getAttribute("src") ||
			img.getAttribute("data-src") ||
			img.getAttribute("data-original") ||
			"";
		let name = "image";
		if (/^data:/i.test(src)) {
			const m = /^data:image\/([a-z+.-]+)/i.exec(src);
			const ext = m
				? m[1].replace("svg+xml", "svg").replace("jpeg", "jpg")
				: "png";
			name = "image." + ext;
		} else {
			try {
				name =
					decodeURIComponent(
						(src.split("/").pop() || "image").split("?")[0],
					).slice(0, 24) || "image";
			} catch (e) {
				name = "image";
			}
		}
		const row = makeRowFromText("// 🖼 " + name + " — 点击查看原图", "cmt");
		if (src) {
			row.querySelector(".tx").style.cursor = "pointer";
			row.addEventListener("click", () => openImageModal(src, name));
		}
		return row;
	}

	/* ---------------- 图片弹窗（可拖拽 / 可缩放） ---------------- */

	function openImageModal(src, name) {
		const root = state.shadow;
		if (!root) return;
		let modal = root.getElementById("img-modal");
		if (!modal) {
			modal = document.createElement("div");
			modal.id = "img-modal";
			modal.className = "img-modal";
			modal.style.width = "100px";
			modal.style.height = "100px";
			modal.innerHTML =
				'<div class="im-bar"><span class="im-name"></span><span class="im-open" title="在新标签页打开">↗</span><span class="im-close" title="关闭">×</span></div>' +
				'<div class="im-body"><img alt=""></div>' +
				'<div class="im-resize"></div>';
			root.querySelector(".win").appendChild(modal);

			const bar = modal.querySelector(".im-bar");
			const grip = modal.querySelector(".im-resize");

			// 拖拽移动（标题栏）
			bar.addEventListener("mousedown", (e) => {
				if (e.target.closest(".im-open, .im-close")) return;
				e.preventDefault();
				const rect = modal.getBoundingClientRect();
				const offX = e.clientX - rect.left;
				const offY = e.clientY - rect.top;
				const move = (ev) => {
					modal.style.left = ev.clientX - offX + "px";
					modal.style.top = ev.clientY - offY + "px";
				};
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			});

			// 拖拽缩放（右下角），最小 100×100
			grip.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const rect = modal.getBoundingClientRect();
				const startX = e.clientX;
				const startY = e.clientY;
				const startW = rect.width;
				const startH = rect.height;
				const move = (ev) => {
					modal.style.width =
						Math.max(100, startW + ev.clientX - startX) + "px";
					modal.style.height =
						Math.max(100, startH + ev.clientY - startY) + "px";
				};
				const up = () => {
					window.removeEventListener("mousemove", move);
					window.removeEventListener("mouseup", up);
				};
				window.addEventListener("mousemove", move);
				window.addEventListener("mouseup", up);
			});

			modal
				.querySelector(".im-close")
				.addEventListener("click", closeImageModal);
			modal.querySelector(".im-open").addEventListener("click", () => {
				const img = modal.querySelector("img");
				if (img && img.src) window.open(img.src, "_blank", "noopener");
			});

			// 首次打开居中；之后保留用户拖的位置
			modal.style.left = (window.innerWidth - 100) / 2 + "px";
			modal.style.top = (window.innerHeight - 100) / 2 + "px";
		}
		const img = modal.querySelector("img");
		img.src = src;
		modal.querySelector(".im-name").textContent = name || "image";
		modal.classList.add("on");
	}

	function closeImageModal() {
		const modal = state.shadow && state.shadow.getElementById("img-modal");
		if (modal) modal.classList.remove("on");
	}

	// 把知乎 RichText 的 DOM 转换成等宽"代码行"数组（保守高亮：只上色，不加符号）
	function walk(container, out) {
		let buf = document.createDocumentFragment();
		const flush = () => {
			if (!buf.childNodes.length) return;
			const row = document.createElement("div");
			row.className = "line";
			const tx = document.createElement("span");
			tx.className = "tx";
			tx.appendChild(buf);
			row.appendChild(tx);
			out.push(row);
			buf = document.createDocumentFragment();
		};

		for (const child of Array.from(container.childNodes)) {
			if (child.nodeType === 3) {
				const c = cloneInline(child);
				if (c) buf.appendChild(c);
				continue;
			}
			if (child.nodeType !== 1) continue;
			const tag = child.tagName;
			if (SKIP.has(tag)) continue;

			if (INLINE.has(tag)) {
				if (tag === "IMG") {
					flush();
					out.push(imageRow(child));
					continue;
				}
				const c = cloneInline(child);
				if (c) buf.appendChild(c);
				continue;
			}

			flush();
			switch (tag) {
				case "P":
				case "DIV":
				case "SECTION":
				case "ARTICLE":
				case "DD":
				case "DT": {
					if (
						!child.textContent.trim() &&
						!child.querySelector("img,br")
					) {
						out.push(emptyRow());
					} else {
						walk(child, out);
					}
					break;
				}
				case "H1":
				case "H2":
				case "H3":
				case "H4":
				case "H5":
				case "H6": {
					out.push(makeRowFromEl(child, "ty"));
					out.push(emptyRow());
					break;
				}
				case "BLOCKQUOTE": {
					const sub = [];
					walk(child, sub);
					sub.forEach((r) => {
						r.classList.add("cmt");
						out.push(r);
					});
					out.push(emptyRow());
					break;
				}
				case "PRE": {
					const text = child.textContent.replace(/\t/g, "  ");
					const lines = text.split("\n");
					while (lines.length && !lines[lines.length - 1].trim())
						lines.pop();
					lines.forEach((l) => out.push(makeRowFromText(l, "str")));
					out.push(emptyRow());
					break;
				}
				case "UL":
				case "OL": {
					let i = 1;
					for (const li of Array.from(child.children)) {
						if (li.tagName !== "LI") continue;
						const sub = [];
						walk(li, sub);
						const marker = tag === "OL" ? i++ + ". " : "- ";
						if (sub.length) {
							const tx = sub[0].querySelector(".tx");
							const pre = document.createElement("span");
							pre.className = "op";
							pre.textContent = marker;
							if (tx) tx.prepend(pre);
							sub.slice(1).forEach((r) => r.classList.add("ind"));
							sub.forEach((r) => out.push(r));
						} else {
							out.push(
								makeRowFromText(
									marker + li.textContent.trim(),
									"op",
								),
							);
						}
					}
					out.push(emptyRow());
					break;
				}
				case "HR":
					out.push(makeRowFromText("// " + "—".repeat(40), "cmt"));
					break;
				case "FIGURE":
				case "IMG": {
					const img =
						tag === "IMG" ? child : child.querySelector("img");
					if (img) out.push(imageRow(img));
					break;
				}
				case "TABLE":
					out.push(
						makeRowFromText(
							"// [table] " +
								child.textContent
									.replace(/\s+/g, " ")
									.trim()
									.slice(0, 120),
							"cmt",
						),
					);
					break;
				default:
					walk(child, out);
			}
		}
		flush();
	}

	/* ---------------- 知乎内容读取 ---------------- */

	function readQuestion() {
		const titleEl = qs(
			document,
			"h1.QuestionHeader-title",
			".QuestionHeader h1",
			"h1",
		);
		let title = titleEl ? titleEl.textContent.trim() : "";
		if (!title)
			title =
				document.title.replace(/\s*[-–—]\s*知乎.*$/, "").trim() ||
				"untitled";
		const topics = qsa(
			document,
			".QuestionHeader-tags .Tag",
			".QuestionHeader a.Tag",
			".Question-topics .Tag",
		)
			.map((el) => el.textContent.trim())
			.filter(Boolean)
			.slice(0, 8);
		return { title, topics };
	}

	function readAnswer(item) {
		const contentRoot = qs(
			item,
			".RichContent-inner",
			".RichContent",
			".RichText",
		);
		if (!contentRoot) return null;
		const rich = qs(contentRoot, ".RichText") || contentRoot;
		const textLen = rich.textContent.trim().length;
		if (!textLen && !rich.querySelector("img")) return null;

		const authorEl = qs(
			item,
			".AuthorInfo-name a",
			".AuthorInfo-name",
			'[itemprop="name"]',
		);
		const headlineEl = qs(item, ".AuthorInfo-headline");
		const voteEl = qs(
			item,
			'button[class*="VoteButton--up"]',
			".VoteButton--up",
			'button[class*="VoteButton"]',
		);
		let comment = "";
		for (const b of Array.from(item.querySelectorAll("button"))) {
			const t = b.textContent.replace(/\s+/g, " ").trim();
			if (/评论/.test(t) && !/写评论/.test(t) && t.length < 20) {
				comment = t;
				break;
			}
		}
		const timeEl = qs(
			item,
			".ContentItem-time",
			"time",
			'[itemprop="dateModified"]',
		);

		const rows = [];
		walk(rich, rows);

		return {
			author: authorEl ? authorEl.textContent.trim() : "匿名用户",
			headline: headlineEl
				? headlineEl.textContent.replace(/\s+/g, " ").trim()
				: "",
			vote: voteEl
				? voteEl.textContent.replace(/\s+/g, " ").trim()
				: "赞同",
			comment: comment || "评论",
			time: timeEl
				? timeEl.getAttribute("content") ||
					timeEl.textContent.replace(/\s+/g, " ").trim()
				: "",
			rows,
			textLen,
		};
	}

	function fileSafe(name) {
		return (name || "anon").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 18);
	}

	/* ---------------- 干扰板块过滤（相似推荐 / 猜你喜欢 / 广告等） ---------------- */

	const NOISE_HEAD =
		/^\s*(猜您?喜欢|相似推荐|相关推荐|相关问题|推荐阅读|相关阅读|热门推荐|热门回答|更多内容|更多推荐|商业推广|广告)\s*$/;
	const NOISE_SIG =
		/(Recommendations?|GuessYouLike|SimilarQuestion|AdModule|AdContainer|TopstoryItem--advert|Pc-card|HotList|Bottombar|Banner|GlobalSideBar)/i;
	const NOISE_ZONE =
		'.Question-sideColumn, .GlobalSideBar, [class*="SideColumn"], [class*="sideColumn"], [class*="Sidebar"]';

	function isNoise(el) {
		if (el.closest && el.closest(NOISE_ZONE)) return true;
		let node = el;
		for (
			let depth = 0;
			depth < 6 && node && node !== document.documentElement;
			depth++
		) {
			const sig = String(node.className || "") + " #" + (node.id || "");
			if (NOISE_SIG.test(sig)) return true;
			let sib = node.previousElementSibling;
			let hops = 0;
			while (sib && hops++ < 8) {
				if (sibHeadOnly(sib)) return true;
				sib = sib.previousElementSibling;
			}
			node = node.parentElement;
		}
		return false;
	}

	// 只有当兄弟节点「本身」是噪声标题、或只包着一个噪声标题时才算数，
	// 否则侧栏/大块内容里夹一个标题会把后面的正文全误杀
	function sibHeadOnly(sib) {
		const t = (sib.textContent || "").trim();
		if (t.length < 30 && NOISE_HEAD.test(t)) return true;
		const h =
			sib.querySelector &&
			sib.querySelector('h1,h2,h3,[class*="Title"],[class*="title"]');
		if (h) {
			const ht = h.textContent.trim();
			if (NOISE_HEAD.test(ht) && t.length - ht.length < 10) return true;
		}
		return false;
	}

	/* ---------------- 专栏文章（zhuanlan.zhihu.com/p/*）读取 ---------------- */

	function readArticle() {
		const container = qs(
			document,
			".Post-RichTextContainer",
			".Post-RichText",
		);
		if (!container) return null;
		const rich = qs(container, ".RichText") || container;
		const textLen = rich.textContent.trim().length;
		if (!textLen) return null;

		const titleEl = qs(document, "h1.Post-Title", ".Post-Header h1", "h1");
		const authorEl = qs(
			document,
			".Post-AuthorInfo .AuthorInfo-name a",
			".Post-AuthorInfo .AuthorInfo-name",
			".AuthorInfo-name a",
			".AuthorInfo-name",
		);
		const headlineEl = qs(
			document,
			".Post-AuthorInfo .AuthorInfo-headline",
			".AuthorInfo-headline",
		);
		const voteEl = qs(
			document,
			'button[class*="VoteButton--up"]',
			".VoteButton--up",
		);
		let comment = "";
		for (const b of Array.from(document.querySelectorAll("button"))) {
			const t = b.textContent.replace(/\s+/g, " ").trim();
			if (/条评论|评论\s*\d/.test(t) && t.length < 20) {
				comment = t;
				break;
			}
		}
		const timeEl = qs(
			document,
			".Post-publishedTime",
			".ContentItem-time",
			"time",
			'[itemprop="dateModified"]',
		);
		const topics = qsa(
			document,
			".Post-topicsAndLabels .Tag",
			".Post-Topic .Tag",
			".Post-topicsAndLabels a",
		)
			.map((el) => el.textContent.trim())
			.filter(Boolean)
			.slice(0, 8);

		const rows = [];
		walk(rich, rows);

		return {
			title: titleEl
				? titleEl.textContent.trim()
				: document.title.replace(/\s*[-–—]\s*知乎.*$/, "").trim() ||
					"untitled",
			topics,
			author: authorEl ? authorEl.textContent.trim() : "匿名用户",
			headline: headlineEl
				? headlineEl.textContent.replace(/\s+/g, " ").trim()
				: "",
			vote: voteEl
				? voteEl.textContent.replace(/\s+/g, " ").trim()
				: "赞同",
			comment: comment || "评论",
			time: timeEl
				? timeEl.getAttribute("content") ||
					timeEl.textContent.replace(/\s+/g, " ").trim()
				: "",
			rows,
			textLen,
		};
	}

	/* ---------------- 首页信息流（git log 风格） ---------------- */

	function detectMode() {
		const path = location.pathname;
		if (path === "/") return "feed";
		if (path.startsWith("/p/")) return "article";
		if (path.startsWith("/question/") || path.startsWith("/answer/"))
			return "question";
		if (qs(document, ".Post-RichTextContainer", ".Post-RichText"))
			return "article";
		if (qs(document, '[class*="TopstoryItem"]')) return "feed";
		return "question";
	}

	// 由标题+作者派生的稳定假 commit hash
	function fakeHash(s) {
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return h.toString(16).padStart(8, "0").slice(0, 7);
	}

	function feedCandidates() {
		return qsa(
			document,
			'[class*="TopstoryItem"]',
			".Topstory-mainColumn .ContentItem",
		);
	}

	function readFeedEntry(item) {
		if (isNoise(item)) return null;
		const rich = qs(
			item,
			".RichContent-inner .RichText",
			".RichContent .RichText",
			".RichText",
		);
		const text = rich ? rich.textContent.replace(/\s+/g, " ").trim() : "";
		const linkEl = qs(
			item,
			"h2.ContentItem-title a",
			".ContentItem-title a",
			"h2 a",
		);
		const titleEl = linkEl || qs(item, "h2.ContentItem-title", "h2");
		if (!text && !titleEl) return null;

		const authorEl = qs(item, ".AuthorInfo-name a", ".AuthorInfo-name");
		const voteEl = qs(
			item,
			'button[class*="VoteButton--up"]',
			".VoteButton--up",
		);
		let comment = "";
		for (const b of Array.from(item.querySelectorAll("button"))) {
			const t = b.textContent.replace(/\s+/g, " ").trim();
			if (/条评论|评论\s*\d/.test(t) && t.length < 20) {
				comment = t;
				break;
			}
		}
		const timeEl = qs(item, ".ContentItem-time", "time");

		const author = authorEl ? authorEl.textContent.trim() : "匿名用户";
		const hasTitle = !!titleEl;
		let title;
		let excerpt;
		if (hasTitle) {
			title = titleEl.textContent.replace(/\s+/g, " ").trim();
			excerpt = text.slice(0, 200) + (text.length > 200 ? "…" : "");
		} else {
			// 想法等无标题内容：优先在 32 字内的断句处切标题，避免劈开句子
			let cut = -1;
			for (const ch of [
				"。",
				"！",
				"？",
				"!",
				"?",
				"；",
				";",
				"，",
				",",
				"、",
			]) {
				const i = text.indexOf(ch);
				if (i >= 0 && i < 32 && i + 1 > cut) cut = i + 1;
			}
			if (cut < 0) cut = Math.min(24, text.length);
			title = text
				.slice(0, cut)
				.replace(/[，,。.、!！?？;；:：\s]+$/, "")
				.trim();
			if (title.length > 26) title = title.slice(0, 24) + "…";
			const rest = text
				.slice(cut)
				.replace(/^[，,。.、!！?？;；:：\s]+/, "");
			excerpt = rest.slice(0, 200) + (rest.length > 200 ? "…" : "");
		}
		const meta = [
			voteEl ? voteEl.textContent.replace(/\s+/g, " ").trim() : "",
			comment,
			timeEl ? timeEl.textContent.replace(/\s+/g, " ").trim() : "",
		]
			.filter(Boolean)
			.join(" · ");

		return {
			hash: fakeHash(title + author + text.slice(0, 40)),
			type: hasTitle ? "feat" : "docs",
			title,
			href: linkEl ? linkEl.getAttribute("href") || "" : "",
			author,
			excerpt,
			meta,
			textLen: text.length,
		};
	}

	// 一条 feed 卡片 = 一条 commit：
	//   a3f9c21  feat(作者): 标题
	//            摘要……
	//            // 12.4K 赞同 · 342 条评论 · 3 小时前
	function feedEntrySection(idx, entry) {
		const sec = document.createElement("section");
		sec.className = "ans";
		sec.dataset.idx = String(idx);
		const code = document.createElement("div");
		code.className = "code";

		const subject = document.createElement("div");
		subject.className = "line";
		const tx = document.createElement("span");
		tx.className = "tx";
		const hash = document.createElement("span");
		hash.className = "num";
		hash.textContent = entry.hash;
		const gap = document.createElement("span");
		gap.className = "op";
		gap.textContent = "  ";
		const type = document.createElement("span");
		type.className = "kw";
		type.textContent = entry.type;
		const parenL = document.createElement("span");
		parenL.className = "op";
		parenL.textContent = "(";
		const fn = document.createElement("span");
		fn.className = "fn";
		fn.textContent = entry.author;
		const parenR = document.createElement("span");
		parenR.className = "op";
		parenR.textContent = "): ";
		const title =
			entry.href && !/^\s*javascript:/i.test(entry.href)
				? document.createElement("a")
				: document.createElement("span");
		title.className = "ty";
		title.textContent = entry.title;
		if (title.tagName === "A") {
			title.setAttribute("href", entry.href);
			title.setAttribute("target", "_blank");
			title.setAttribute("rel", "noopener noreferrer");
		}
		tx.appendChild(hash);
		tx.appendChild(gap);
		tx.appendChild(type);
		tx.appendChild(parenL);
		tx.appendChild(fn);
		tx.appendChild(parenR);
		tx.appendChild(title);
		subject.appendChild(tx);
		code.appendChild(subject);

		if (entry.excerpt)
			code.appendChild(makeRowFromText(entry.excerpt, "ind"));
		if (entry.meta)
			code.appendChild(makeRowFromText("// " + entry.meta, "cmt ind"));
		code.appendChild(emptyRow());
		sec.appendChild(code);
		return sec;
	}

	function appendFeedEntry(idx, entry) {
		const code = state.shadow.getElementById("code");
		const tree = state.shadow.getElementById("sb-tree");
		const outline = state.shadow.getElementById("sb-outline");
		if (!code) return;
		code.appendChild(feedEntrySection(idx, entry));
		state.totalLines += 3;
		const nav = {
			fileName: entry.hash + ".ts",
			author: entry.title.slice(0, 18),
		};
		if (tree) tree.appendChild(sidebarItem(idx, nav));
		if (outline) outline.appendChild(outlineItem(idx, nav));
	}

	function replaceFeedEntry(idx, entry) {
		const code = state.shadow.getElementById("code");
		const old = state.shadow.querySelector(
			'section[data-idx="' + idx + '"]',
		);
		if (!code || !old) return;
		code.replaceChild(feedEntrySection(idx, entry), old);
	}

	function refreshFeed() {
		const code = state.shadow.getElementById("code");
		const fname = "topstory-log.ts";
		if (code && !code.childElementCount) {
			const head = document.createElement("div");
			head.className = "code head";
			head.appendChild(
				makeRowFromText(
					"// zhihu.com 首页推荐流 · git log --oneline",
					"cmt",
				),
			);
			head.appendChild(makeRowFromText("// " + "—".repeat(40), "cmt"));
			head.appendChild(emptyRow());
			code.appendChild(head);
			const tab = state.shadow.getElementById("tab-label");
			if (tab) tab.textContent = fname;
			const crumbs = state.shadow.getElementById("crumbs");
			if (crumbs) crumbs.textContent = "zhihu-fishmask › " + fname;
			const title = state.shadow.getElementById("wintitle");
			if (title)
				title.textContent =
					fname + " — zhihu-fishmask — Visual Studio Code";
		}

		for (const item of feedCandidates()) {
			const entry = readFeedEntry(item);
			if (!entry) continue;
			const rec = state.records.get(item);
			if (!rec) {
				const idx = ++state.seq;
				state.records.set(item, { idx, len: entry.textLen });
				appendFeedEntry(idx, entry);
			} else if (entry.textLen > rec.len * 1.25) {
				rec.len = entry.textLen;
				replaceFeedEntry(rec.idx, entry);
			}
			maybeExpand(item);
		}
	}

	/* ---------------- 渲染 ---------------- */

	function answerSection(idx, data) {
		const sec = document.createElement("section");
		sec.className = "ans";
		const code = document.createElement("div");
		code.className = "code";

		const meta = [
			"/**",
			" * @author  " + (data.author || "匿名用户"),
			data.headline ? " * @bio     " + data.headline : "",
			" * @votes   " +
				data.vote +
				"   ·   @comments " +
				data.comment +
				(data.time ? "   ·   @date " + data.time : ""),
			" */",
		];
		meta.forEach((m) => code.appendChild(makeRowFromText(m, "cmt")));
		code.appendChild(emptyRow());
		data.rows.forEach((r) => code.appendChild(r));

		sec.dataset.idx = String(idx);
		sec.appendChild(code);
		return sec;
	}

	function buildHeader(q) {
		const code = document.createElement("div");
		code.className = "code head";
		q.topics.forEach((t) =>
			code.appendChild(makeRowFromText("// #" + t, "cmt")),
		);
		if (q.topics.length) code.appendChild(emptyRow());
		code.appendChild(makeRowFromText(q.title, "ty"));
		code.appendChild(emptyRow());
		code.appendChild(makeRowFromText("// " + "—".repeat(40), "cmt"));
		code.appendChild(emptyRow());
		return code;
	}

	function sidebarItem(idx, data) {
		const item = document.createElement("div");
		item.className = "sb-file";
		const n = String(idx).padStart(2, "0");
		item.innerHTML =
			'<span class="tsicon sm">TS</span><span class="fname"></span>';
		item.querySelector(".fname").textContent =
			data.fileName || n + "_" + fileSafe(data.author) + ".ts";
		item.addEventListener("click", () => {
			const target = state.shadow.querySelector(
				'section[data-idx="' + idx + '"]',
			);
			if (target)
				target.scrollIntoView({ behavior: "smooth", block: "start" });
		});
		return item;
	}

	function outlineItem(idx, data) {
		const item = document.createElement("div");
		item.className = "sb-sym";
		item.innerHTML =
			'<span class="fnicon">ƒ</span><span class="fname"></span>';
		item.querySelector(".fname").textContent = data.author || "匿名用户";
		item.addEventListener("click", () => {
			const target = state.shadow.querySelector(
				'section[data-idx="' + idx + '"]',
			);
			if (target)
				target.scrollIntoView({ behavior: "smooth", block: "start" });
		});
		return item;
	}

	// 文章模式：OUTLINE 显示正文标题（h2/h3），点击跳转
	function buildOutlineFromHeadings(idx) {
		const outline = state.shadow.getElementById("sb-outline");
		const sec = state.shadow.querySelector(
			'section[data-idx="' + idx + '"]',
		);
		if (!outline || !sec) return;
		const heads = Array.from(sec.querySelectorAll(".line.ty"));
		if (
			outline.dataset.for === String(idx) &&
			outline.childElementCount === heads.length
		)
			return;
		outline.dataset.for = String(idx);
		outline.innerHTML = "";
		heads.forEach((row) => {
			const item = document.createElement("div");
			item.className = "sb-sym";
			item.innerHTML =
				'<span class="fnicon">ƒ</span><span class="fname"></span>';
			item.querySelector(".fname").textContent = row.textContent
				.trim()
				.slice(0, 24);
			item.addEventListener("click", () =>
				row.scrollIntoView({ behavior: "smooth", block: "start" }),
			);
			outline.appendChild(item);
		});
	}

	function appendAnswer(idx, data) {
		const code = state.shadow.getElementById("code");
		const tree = state.shadow.getElementById("sb-tree");
		const outline = state.shadow.getElementById("sb-outline");
		if (!code) return;
		const sec = answerSection(idx, data);
		code.appendChild(sec);
		state.totalLines += data.rows.length + 6;
		if (tree) tree.appendChild(sidebarItem(idx, data));
		if (outline) outline.appendChild(outlineItem(idx, data));
	}

	function replaceAnswer(idx, data) {
		const code = state.shadow.getElementById("code");
		const old = state.shadow.querySelector(
			'section[data-idx="' + idx + '"]',
		);
		if (!code || !old) return;
		const sec = answerSection(idx, data);
		code.replaceChild(sec, old);
	}

	/* ---------------- 伪装外壳 ---------------- */

	const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .win {
      position: fixed; inset: 0; z-index: 2147483646;
      display: flex; flex-direction: column;
      background: #1f1f1f; color: #d4d4d4;
      font-family: 'JetBrains Mono','Cascadia Code','SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
      font-size: 13px; line-height: 1.55;
    }
    /* ---- title bar ---- */
    .titlebar {
      height: 35px; flex: 0 0 35px; background: #181818; color: #cccccc;
      display: flex; align-items: center; padding: 0 12px; gap: 16px;
      font-size: 12px; user-select: none;
    }
    .lights { display: flex; gap: 8px; }
    .lt { width: 12px; height: 12px; border-radius: 50%; display: inline-block; cursor: pointer; }
    .lt.red { background: #ff5f57; } .lt.yel { background: #febc2e; } .lt.grn { background: #28c840; }
    .menu { display: flex; gap: 14px; color: #cccccc; }
    .menu span { opacity: .85; }
    .wintitle { flex: 1; text-align: center; color: #9d9d9d; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .spacer { width: 60px; }
    /* ---- body ---- */
    .body { flex: 1; display: flex; min-height: 0; }
    .activity {
      width: 48px; flex: 0 0 48px; background: #181818;
      display: flex; flex-direction: column; justify-content: space-between;
      padding: 8px 0; user-select: none;
    }
    .ic {
      height: 44px; display: flex; align-items: center; justify-content: center;
      color: #858585; font-size: 21px; cursor: default;
    }
    .ic.on { color: #ffffff; border-left: 2px solid #ffffff; }
    .sidebar {
      width: 260px; flex: 0 0 260px; background: #181818; color: #cccccc;
      overflow-y: auto; user-select: none; padding-top: 6px;
    }
    .sb-title { font-size: 11px; letter-spacing: .08em; padding: 4px 20px; color: #bbbbbb; }
    .sb-root { font-size: 11.5px; letter-spacing: .03em; padding: 3px 8px 3px 12px; color: #bbbbbb; }
    .sb-file, .sb-sym {
      display: flex; align-items: center; gap: 6px;
      padding: 2px 8px 2px 32px; font-size: 12.5px; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sb-sym { padding-left: 36px; }
    .sb-file:hover, .sb-sym:hover { background: #2a2d2e; }
    .sb-file .fname, .sb-sym .fname { overflow: hidden; text-overflow: ellipsis; }
    .tsicon.sm { font-size: 9px; color: #3b87d4; border: 1px solid #3b87d4; border-radius: 2px; padding: 0 2px; line-height: 1.2; }
    .fnicon { color: #b187d8; font-style: italic; }
    /* ---- editor ---- */
    .main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: #1f1f1f; }
    .tabs {
      height: 35px; flex: 0 0 35px; background: #181818; display: flex; align-items: stretch;
      user-select: none; overflow: hidden;
    }
    .tab {
      display: flex; align-items: center; gap: 8px; padding: 0 12px;
      background: #1f1f1f; color: #ffffff; font-size: 12.5px;
      border-top: 1px solid #007acc; white-space: nowrap; max-width: 420px;
    }
    .tab .fname { overflow: hidden; text-overflow: ellipsis; }
    .tsicon { font-size: 10px; color: #3b87d4; border: 1px solid #3b87d4; border-radius: 2px; padding: 0 3px; }
    .tab .close { color: #bbbbbb; cursor: pointer; padding: 0 2px; font-size: 14px; }
    .tab .close:hover { color: #ffffff; }
    .crumbs {
      height: 22px; flex: 0 0 22px; color: #858585; font-size: 11.5px;
      padding: 2px 20px; user-select: none;
      border-bottom: 1px solid #2b2b2b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .editor {
      flex: 1; overflow-y: auto; overflow-x: hidden; position: relative;
      padding: 8px 96px 240px 0;
    }
    .editor::-webkit-scrollbar { width: 14px; }
    .editor::-webkit-scrollbar-thumb { background: #4a4a4a; }
    .editor::-webkit-scrollbar-track { background: #1f1f1f; }
    #code { counter-reset: ln; }
    .code.head { padding-top: 4px; }
    .ans { padding: 14px 0 22px; }
    .ans + .ans { border-top: 1px solid #2b2b2b; }
    .line {
      display: grid; grid-template-columns: 56px 1fr;
      min-height: 20px; padding-right: 8px; white-space: pre-wrap; word-break: break-word;
    }
    .line::before {
      counter-increment: ln; content: counter(ln);
      color: #6e7681; text-align: right; padding-right: 16px; user-select: none;
      font-variant-numeric: tabular-nums;
    }
    .line:hover { background: #ffffff08; }
    .line .tx { grid-column: 2; color: #d4d4d4; }
    .line.ind .tx { padding-left: 2em; }
    .line.cmt .tx, .line.cmt { color: #6a9955; }
    .line.str .tx { color: #ce9178; }
    .line.ty .tx { color: #4ec9b0; }
    .line.op .tx { color: #d4d4d4; }
    .kw { color: #569cd6; }
    .num { color: #b5cea8; }
    .ty { color: #4ec9b0; }
    a.ty { text-decoration: none; }
    a.ty:hover { text-decoration: underline; }
    .fn { color: #dcdcaa; text-decoration: none; }
    a.fn:hover { text-decoration: underline; }
    .var { color: #9cdcfe; font-style: italic; }
    .str { color: #ce9178; }
    .cmt { color: #6a9955; }
    .op { color: #d4d4d4; }
    /* fake minimap */
    .minimap {
      position: absolute; top: 0; right: 8px; bottom: 0; width: 76px;
      pointer-events: none; opacity: .16;
      background: repeating-linear-gradient(to bottom,
        #d4d4d4 0 2px, transparent 2px 4px,
        #d4d4d4 4px 7px, transparent 7px 11px,
        #6a9955 11px 12px, transparent 12px 17px);
      background-size: 100% 46px;
      -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 92%, transparent 100%);
    }
    /* ---- image modal ---- */
    .img-modal {
      position: fixed; z-index: 30; display: none;
      flex-direction: column;
      background: #1e1e1e; border: 1px solid #454545; border-radius: 4px;
      box-shadow: 0 8px 28px rgba(0,0,0,.55); overflow: hidden;
    }
    .img-modal.on { display: flex; }
    .img-modal .im-bar {
      height: 24px; flex: 0 0 24px; background: #2d2d2d; color: #cccccc;
      display: flex; align-items: center; gap: 8px; padding: 0 8px;
      font-size: 11px; cursor: move; user-select: none;
    }
    .img-modal .im-name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .img-modal .im-open, .img-modal .im-close { color: #9d9d9d; cursor: pointer; }
    .img-modal .im-open:hover, .img-modal .im-close:hover { color: #ffffff; }
    .img-modal .im-body {
      flex: 1; min-height: 0; background: #101010;
      display: flex; align-items: center; justify-content: center;
    }
    .img-modal .im-body img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
    .img-modal .im-resize {
      position: absolute; right: 0; bottom: 0; width: 12px; height: 12px;
      cursor: nwse-resize;
      background: linear-gradient(135deg, transparent 45%, #9d9d9d 45%, #9d9d9d 55%, transparent 55%);
    }
    /* ---- status bar ---- */
    .statusbar {
      height: 22px; flex: 0 0 22px; background: #007acc; color: #ffffff;
      display: flex; align-items: center; justify-content: space-between;
      font-size: 12px; padding: 0 10px; user-select: none;
    }
    .st { display: flex; align-items: center; height: 100%; }
    .st-item { padding: 0 7px; height: 100%; display: flex; align-items: center; white-space: nowrap; }
    .st-item.hide { display: none; }
    .st-item.hot { background: #ffffff22; }
  `;

	const SHELL = `
    <div class="win">
      <div class="titlebar">
        <div class="lights"><span class="lt red"></span><span class="lt yel"></span><span class="lt grn"></span></div>
        <div class="menu"><span>File</span><span>Edit</span><span>Selection</span><span>View</span><span>Go</span><span>Run</span><span>Terminal</span><span>Help</span></div>
        <div class="wintitle" id="wintitle">untitled — zhihu-fishmask — Visual Studio Code</div>
        <div class="spacer"></div>
      </div>
      <div class="body">
        <div class="activity">
          <div>
            <div class="ic on" title="Explorer">▤</div>
            <div class="ic" title="Search">⌕</div>
            <div class="ic" title="Source Control">⑂</div>
            <div class="ic" title="Run and Debug">▷</div>
            <div class="ic" title="Extensions">▦</div>
          </div>
          <div>
            <div class="ic" title="Accounts">☺</div>
            <div class="ic" title="Manage">⚙</div>
          </div>
        </div>
        <div class="sidebar">
          <div class="sb-title">EXPLORER</div>
          <div class="sb-root" id="sb-root">▾ ZHIHU-FISHMASK</div>
          <div class="sb-tree" id="sb-tree"></div>
          <div class="sb-root" style="margin-top:10px">▾ OUTLINE</div>
          <div class="sb-tree" id="sb-outline"></div>
        </div>
        <div class="main">
          <div class="tabs">
            <div class="tab active">
              <span class="tsicon">TS</span>
              <span class="fname" id="tab-label">untitled.ts</span>
              <span class="close" id="tab-close">×</span>
            </div>
          </div>
          <div class="crumbs" id="crumbs">zhihu-fishmask &gt; untitled.ts</div>
          <div class="editor" id="editor">
            <div id="code" class="code"></div>
            <div class="minimap"></div>
          </div>
        </div>
      </div>
      <div class="statusbar">
        <div class="st">
          <span class="st-item">⑂ main*</span>
          <span class="st-item">↻ 0 ⨯ &nbsp;0 ⚠</span>
          <span class="st-item" id="st-hint">Ctrl+\` 隐藏</span>
        </div>
        <div class="st">
          <span class="st-item" id="st-ln">Ln 1, Col 1</span>
          <span class="st-item">Spaces: 2</span>
          <span class="st-item">UTF-8</span>
          <span class="st-item">LF</span>
          <span class="st-item">{ } TypeScript</span>
          <span class="st-item">Prettier ✓</span>
          <span class="st-item" id="st-clock">--:--</span>
        </div>
      </div>
    </div>
  `;

	function mount() {
		if (state.host) return;
		const host = document.createElement("div");
		host.id = "zfm-host";
		const shadow = host.attachShadow({ mode: "open" });
		shadow.innerHTML = "<style>" + STYLE + "</style>" + SHELL;
		document.documentElement.appendChild(host);
		state.host = host;
		state.shadow = shadow;

		// 红灯 / 标签页关闭 = 老板键
		shadow
			.querySelector(".lt.red")
			.addEventListener("click", () => toggle(false));
		shadow
			.getElementById("tab-close")
			.addEventListener("click", () => toggle(false));

		// Ln / Col 状态栏跟随滚动
		const editor = shadow.getElementById("editor");
		editor.addEventListener("scroll", () => {
			const total = Math.max(state.totalLines, 1);
			const ratio =
				editor.scrollTop /
				Math.max(editor.scrollHeight - editor.clientHeight, 1);
			const ln = Math.max(1, Math.round(ratio * total));
			const stLn = shadow.getElementById("st-ln");
			if (stLn) stLn.textContent = "Ln " + ln + ", Col " + (1 + (ln % 7));
		});

		// 时钟
		const tick = () => {
			const el = shadow.getElementById("st-clock");
			if (!el) return;
			const d = new Date();
			el.textContent =
				String(d.getHours()).padStart(2, "0") +
				":" +
				String(d.getMinutes()).padStart(2, "0");
		};
		tick();
		setInterval(tick, 20000);

		// 提示条 10 秒后消失（避免路人看到破绽）
		setTimeout(() => {
			const hint = shadow.getElementById("st-hint");
			if (hint) hint.classList.add("hide");
		}, 10000);
	}

	/* ---------------- 刷新 / 增量渲染 ---------------- */

	function maybeExpand(item) {
		const btn = qsa(item, "button").find((b) =>
			/展开阅读全文|展开剩余/.test(b.textContent),
		);
		if (!btn || state.expanded.has(btn)) return;
		state.expanded.add(btn);
		btn.click();
	}

	// 知乎是 SPA：切到另一类页面（问题 / 专栏 / 首页）时清掉上一模式的渲染结果
	function resetView(mode) {
		state.mode = mode;
		state.records = new WeakMap();
		state.expanded = new WeakSet();
		state.seq = 0;
		state.totalLines = 0;
		const code = state.shadow.getElementById("code");
		const tree = state.shadow.getElementById("sb-tree");
		const outline = state.shadow.getElementById("sb-outline");
		if (code) code.innerHTML = "";
		if (tree) tree.innerHTML = "";
		if (outline) {
			outline.innerHTML = "";
			delete outline.dataset.for;
		}
	}

	function refresh() {
		const mode = detectMode();
		if (mode !== state.mode) resetView(mode);

		// 首页推荐流：渲染成 git log 风格
		if (mode === "feed") {
			refreshFeed();
			return;
		}
		const article = readArticle();
		const q = article || readQuestion();
		const fname = fileSafe(q.title.slice(0, 24)) + ".ts";
		const code = state.shadow.getElementById("code");
		if (code && !code.childElementCount) {
			code.appendChild(buildHeader(q));
			const tab = state.shadow.getElementById("tab-label");
			if (tab) tab.textContent = fname;
			const crumbs = state.shadow.getElementById("crumbs");
			if (crumbs) crumbs.textContent = "zhihu-fishmask › " + fname;
			const title = state.shadow.getElementById("wintitle");
			if (title)
				title.textContent =
					fname + " — zhihu-fishmask — Visual Studio Code";
		}

		// 专栏文章页：整篇作为单文件渲染
		if (article) {
			const key = document.documentElement;
			const rec = state.records.get(key);
			let idx;
			if (!rec) {
				idx = ++state.seq;
				article.fileName = fname;
				state.records.set(key, { idx, len: article.textLen });
				appendAnswer(idx, article);
			} else {
				idx = rec.idx;
				if (article.textLen > rec.len * 1.25) {
					rec.len = article.textLen;
					article.fileName = fname;
					replaceAnswer(idx, article);
				}
			}
			buildOutlineFromHeadings(idx);
			return;
		}

		// 问题页：逐个回答渲染，跳过推荐/广告等干扰板块
		const items = qsa(
			document,
			".List-item",
			".AnswerItem",
			'[class*="ContentItem"]',
		);
		for (const item of items) {
			if (isNoise(item)) continue;
			const data = readAnswer(item);
			if (!data) continue;
			const rec = state.records.get(item);
			if (!rec) {
				const idx = ++state.seq;
				state.records.set(item, { idx, len: data.textLen });
				appendAnswer(idx, data);
			} else if (data.textLen > rec.len * 1.25) {
				rec.len = data.textLen;
				replaceAnswer(rec.idx, data);
			}
			maybeExpand(item);
		}
	}

	function setupObserver() {
		if (state.observer) return;
		const obs = new MutationObserver(() => {
			clearTimeout(state.obsTimer);
			state.obsTimer = setTimeout(() => {
				state.obsTimer = 0;
				if (state.active) refresh();
			}, 400);
		});
		obs.observe(document.body, { childList: true, subtree: true });
		state.observer = obs;

		// 编辑区滚到底 → 让知乎加载更多回答
		const editor = state.shadow.getElementById("editor");
		editor.addEventListener("scroll", () => {
			if (
				editor.scrollTop + editor.clientHeight >
				editor.scrollHeight - 600
			) {
				window.scrollTo(0, document.documentElement.scrollHeight);
			}
		});
	}

	/* ---------------- 老板键 ---------------- */

	function toggle(force) {
		const next = typeof force === "boolean" ? force : !state.active;
		if (next === state.active) return;
		state.active = next;

		if (next) {
			if (!state.savedTitle) state.savedTitle = document.title;
			state.host.style.display = "";
			refresh();
			document.title =
				(
					state.shadow.getElementById("tab-label") || {
						textContent: "main.ts",
					}
				).textContent + " — zhihu-fishmask";
			setupObserver();
		} else {
			state.host.style.display = "none";
			if (state.savedTitle) document.title = state.savedTitle;
		}
	}

	function boot() {
		mount();
		toggle(true);

		document.addEventListener(
			"keydown",
			(e) => {
				if (e.ctrlKey && (e.code === "Backquote" || e.key === "`")) {
					e.preventDefault();
					toggle();
					return;
				}
				if (e.key === "Escape") {
					// 弹窗开着时 Esc 只关弹窗，不吃掉老板键的双击节奏
					const modal = state.shadow.getElementById("img-modal");
					if (modal && modal.classList.contains("on")) {
						e.preventDefault();
						closeImageModal();
						return;
					}
					const now = Date.now();
					if (now - state.lastEsc < 400) {
						e.preventDefault();
						toggle();
						state.lastEsc = 0;
					} else {
						state.lastEsc = now;
					}
				}
			},
			true,
		);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}
})();
