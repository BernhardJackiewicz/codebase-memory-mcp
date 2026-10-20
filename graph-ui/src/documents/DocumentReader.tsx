import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent, ElementContent } from 'hast';
import type { DocumentDetail } from './documents-source';
import { resolveDocumentLink } from './documents-source';

function headingText(node: unknown): string {
    if (!node || typeof node !== 'object') return '';
    const item = node as { value?: string; children?: unknown[] };
    return item.value ?? item.children?.map(headingText).join('') ?? '';
}
export function headingAnchor(value: string): string {
    return value.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

function documentHeadingAnchors() {
    return (tree: Root) => {
        const used = new Set<string>();
        const visit = (node: Root | RootContent | ElementContent) => {
            if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
                const base = headingAnchor(headingText(node));
                let id = base, suffix = 0;
                while (used.has(id)) id = `${base}-${++suffix}`;
                used.add(id);
                node.properties.id = id;
            }
            if ('children' in node) node.children.forEach(visit);
        };
        visit(tree);
    };
}

const DocumentNavigation = createContext<{ filePath: string; onLink: (path: string, anchor: string) => void }>({ filePath: '', onLink: () => {} });
// Component types must remain stable across parent updates so reading focus is
// retained. Navigation callbacks update through context without remounting text.
const headings: Components = {};
for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
    headings[tag] = ({ node, children }) => {
        const id = String(node?.properties.id ?? '');
        const Tag = tag;
        return <Tag id={id} tabIndex={-1} data-document-anchor={id} data-document-line={node?.position?.start.line}>{children}</Tag>;
    };
}
const documentComponents: Components = {
    ...headings,
    a: function DocumentLink({ href, children }) {
        const { filePath, onLink } = useContext(DocumentNavigation);
        const link = href && resolveDocumentLink(href, filePath);
        if (!link) return <span>{children}</span>;
        return link.kind === 'external' ? <a href={link.url} target="_blank" rel="noopener noreferrer">{children}</a>
            : <a href={`#${encodeURIComponent(link.anchor || 'document')}`} onClick={event => {
                event.preventDefault(); onLink(link.path, link.anchor);
            }}>{children}</a>;
    },
    img: function DocumentImage({ src, alt }) {
        const { filePath } = useContext(DocumentNavigation);
        const link = typeof src === 'string' && resolveDocumentLink(src, filePath);
        return link && link.kind === 'external' ? <a href={link.url} target="_blank" rel="noopener noreferrer">Image: {alt || 'open image'}</a>
            : <span className="docs-muted">Image: {alt || 'local image'} (not loaded)</span>;
    },
    table: ({ children }) => <div className="docs-table-scroll" tabIndex={0}><table>{children}</table></div>,
};

/** Markdown remains local: links navigate indexed documents, images never fetch automatically. */
export default function DocumentReader({ detail, anchor, line, page, focusRevision, onLink }: {
    detail: DocumentDetail; anchor?: string; line?: number; page?: number; focusRevision?: number; onLink: (path: string, anchor: string) => void;
}) {
    const reader = useRef<HTMLElement>(null);
    const navigation = useMemo(() => ({ filePath: detail.document.file_path, onLink }), [detail.document.file_path, onLink]);
    useEffect(() => {
        if ((!anchor && !line && !page) || !reader.current) return;
        const headings = [...reader.current.querySelectorAll<HTMLElement>('[data-document-anchor]')];
        const match = page ? reader.current.querySelector<HTMLElement>(`[data-document-page="${page}"] h2`)
            : line ? headings.find(element => Number(element.dataset.documentLine) === line)
                : headings.find(element => element.dataset.documentAnchor === anchor || element.dataset.documentAnchor === headingAnchor(anchor!));
        if (match) { match.scrollIntoView?.({ block: 'start' }); match.focus({ preventScroll: true }); }
    }, [anchor, line, page, detail, focusRevision]);
    return <article ref={reader} className="docs-reader" aria-label="Document content">
        {detail.source_mode === 'unavailable' ? <p role="status">The index has this document, but its text is unavailable. Its recorded relationships remain available.</p>
            : !detail.content ? <p>This document has no readable text.</p>
                : detail.document.kind === 'pdf' ? detail.pages?.length ? detail.pages.map(item =>
                    <section key={item.page} data-document-page={item.page}>
                        <h2 tabIndex={-1} data-document-anchor={`page-${item.page}`}>Page {item.page}</h2>
                        <pre className="docs-pdf-text">{item.text || 'Page text is unavailable in this response.'}</pre>
                    </section>) : <><p className="docs-notice">Page locations are unavailable in this snapshot.</p><pre className="docs-pdf-text">{detail.content}</pre></>
                : detail.document.kind === 'diagram' ? <pre aria-label="Diagram source">{detail.content}</pre>
                    : <DocumentNavigation.Provider value={navigation}><Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[documentHeadingAnchors]} components={documentComponents}
                        urlTransform={value => resolveDocumentLink(value, detail.document.file_path) ? value : ''}>{detail.content}</Markdown></DocumentNavigation.Provider>}
    </article>;
}
