import { parseDocument } from 'htmlparser2';
import { findAll, textContent, getOuterHTML } from 'domutils';
import { htmlToText } from '../text.js';

const all = (node, predicate) => findAll(predicate, node.children || []);
const first = (node, predicate) => all(node, predicate)[0];
const cls = (node, name) => (node.attribs?.class || '').split(/\s+/).includes(name);
const txt = (node) => node ? textContent(node).replace(/\s+/g, ' ').trim() : '';
const plain = (node) => node ? htmlToText(getOuterHTML(node)) : '';
const title = (doc) => txt(first(doc, (n) => n.name === 'h1')) || txt(first(doc, (n) => n.name === 'title'));
const main = (doc) => first(doc, (n) => n.attribs?.id === 'region-main') || doc;

function localLink(href, base) {
  try { const u = new URL(href, base); return u.origin === new URL(base).origin ? u : null; }
  catch { return null; }
}

export function parseIdentity(html, base) {
  const doc = parseDocument(html);
  const menu = first(doc, (n) => n.attribs?.id === 'user-menu-toggle');
  const name = txt(first(menu || doc, (n) => cls(n, 'usertext'))) || txt(menu).replace(/[\uF000-\uF8FF]/g, '').trim();
  const loggedIn = !!menu && !/\b(log in|sign in)\b/i.test(name);
  return { connected: loggedIn, name: loggedIn ? name : null, site: base, title: title(doc) };
}

export function parseCourses(html, base) {
  const doc = parseDocument(html);
  const courses = new Map();
  for (const a of all(doc, (n) => n.name === 'a' && !!n.attribs?.href)) {
    const u = localLink(a.attribs.href, base);
    if (u?.pathname !== '/course/view.php' || !/^\d+$/.test(u.searchParams.get('id') || '')) continue;
    const id = u.searchParams.get('id');
    const name = txt(a).replace(/\s+/g, ' ').trim();
    if (name && (!courses.has(id) || name.length > courses.get(id).name.length)) courses.set(id, { id, name, url: u.href });
  }
  return [...courses.values()];
}

export function parseCourse(html, base) {
  const doc = parseDocument(html);
  const sections = all(main(doc), (n) => /^section-\d+$/.test(n.attribs?.id || ''));
  const seen = new Set();
  const result = [];
  for (const s of sections.length ? sections : [main(doc)]) {
    const heading = first(s, (n) => cls(n, 'sectionname')) || first(s, (n) => /^h[23]$/.test(n.name || ''));
    const name = s.attribs?.['data-sectionname'] || txt(heading) || '课程内容';
    const items = [];
    for (const node of all(s, (n) => /^module-\d+$/.test(n.attribs?.id || ''))) {
      const a = first(node, (n) => n.name === 'a' && /\/mod\/[\w]+\/view\.php/.test(n.attribs?.href || ''));
      const url = a && localLink(a.attribs.href, base);
      const id = (node.attribs.id || '').slice(7);
      if (seen.has(id)) continue;
      seen.add(id);
      const kind = url?.pathname.match(/^\/mod\/(\w+)\/view\.php$/)?.[1] || (node.attribs.class || '').match(/modtype_(\w+)/)?.[1] || 'restricted';
      const card = first(node, (n) => !!n.attribs?.['data-activityname']);
      const nameNode = first(node, (n) => cls(n, 'instancename'));
      const activityName = card?.attribs['data-activityname'] || txt(nameNode) || txt(a) || txt(first(node, (n) => cls(n, 'activityname'))) || '受限内容';
      const dates = all(node, (n) => cls(n, 'activity-dates')).map(plain).join('\n');
      items.push({ id, name: activityName.replace(/\s+(File|Folder|Quiz|Assignment|Forum)$/i, ''), type: kind, url: url?.href || null,
        section: name, available: !!url, dates, description: plain(first(node, (n) => cls(n, 'description'))) });
    }
    result.push({ name, items });
  }
  return { name: title(doc), sections: result, items: result.flatMap((s) => s.items) };
}

export function parsePage(html, base) {
  const doc = parseDocument(html);
  const content = main(doc);
  const files = new Map();
  for (const n of all(content, (n) => ['a', 'iframe', 'object', 'embed'].includes(n.name))) {
    const value = n.attribs?.href || n.attribs?.src || n.attribs?.data;
    if (!value) continue;
    const u = localLink(value, base);
    if (u?.pathname.startsWith('/pluginfile.php/')) files.set(u.href, { name: txt(n) || decodeURIComponent(u.pathname.split('/').pop()), url: u.href });
  }
  const body = plain(content);
  return { title: title(doc), text: body, files: [...files.values()] };
}

export function sessionKey(html) {
  return html.match(/["']sesskey["']\s*:\s*["']([^"']+)["']/)?.[1] || null;
}

export function safeName(value) {
  return String(value || 'file').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 150) || 'file';
}
