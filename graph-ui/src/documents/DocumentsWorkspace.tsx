import { useCallback, useEffect, useId, useRef, useState } from 'react';
import AdrWorkspace from '../adr/AdrWorkspace';
import type { AdrWorkspaceProps } from '../adr/AdrWorkspace';
import { useSelectionEvidence, type SelectionEvidenceListener } from '../galaxy/selection-evidence';
import DocumentReader from './DocumentReader';
import DocumentationGraph from './DocumentationGraph';
import {
    createDocumentsSource, documentKindLabel, documentLocation, isDocumentNode, isDocumentPath,
    type DocumentDetail, type DocumentKind, type DocumentNavigationTarget, type DocumentNode, type DocumentRequest, type DocumentsPage, type DocumentsSource,
} from './documents-source';
import './documents.css';

const defaultSource = createDocumentsSource();
type Tab = 'documents' | 'adr';
interface Place { nodeId?: number; filePath?: string; generation: string; anchor?: string; line?: number; page?: number }
export interface DocumentsWorkspaceProps {
    project: string; active: boolean; source?: DocumentsSource; adrSource: AdrWorkspaceProps['source'];
    initialTab?: Tab; onNavigate: (path: string, line?: number, name?: string) => void;
    openDocument?: DocumentNavigationTarget;
    onSelectionEvidence?: SelectionEvidenceListener;
}
const lineOf = (node: DocumentNode) => node.location_kind !== 'pages' && node.start_line > 0 ? node.start_line : undefined;
const message = (error: unknown) => error instanceof Error ? error.message : 'Documentation could not be read. Try again.';
function ProjectDocuments({ project, active, source = defaultSource, adrSource, initialTab = 'documents', openDocument, onNavigate, onSelectionEvidence }: DocumentsWorkspaceProps) {
    const [tab, setTab] = useState<Tab>(initialTab);
    const fieldId = useId();
    const [query, setQuery] = useState(''), [search, setSearch] = useState('');
    const [kind, setKind] = useState<DocumentKind | 'all'>('all');
    const [revision, setRevision] = useState(0);
    const [catalog, setCatalog] = useState<{ key: string; page?: DocumentsPage; error?: string }>();
    const [more, setMore] = useState(false), [moreError, setMoreError] = useState('');
    const [history, setHistory] = useState<{ entries: Place[]; index: number }>({ entries: [], index: -1 });
    const [reading, setReading] = useState<{ key: string; detail?: DocumentDetail; error?: string }>();
    const [readRevision, setReadRevision] = useState(0);
    const [focusRevision, setFocusRevision] = useState(0);
    const pageRequest = useRef<AbortController | undefined>(undefined);
    const connections = useRef<HTMLDivElement>(null);
    const catalogKey = JSON.stringify([project, kind, search, revision]);
    const currentKey = useRef(catalogKey); currentKey.current = catalogKey;
    const page = catalog?.key === catalogKey ? catalog.page : undefined;
    const catalogError = catalog?.key === catalogKey ? catalog.error : undefined;
    const place = history.entries[history.index];
    const readingKey = JSON.stringify([project, place, readRevision]);
    const detail = reading?.key === readingKey ? reading.detail : undefined;
    const readError = reading?.key === readingKey ? reading.error : undefined;
    const showingDocs = active && tab === 'documents';
    useEffect(() => { setTab(initialTab); }, [initialTab]);
    useEffect(() => {
        if (!showingDocs || !project) return;
        const controller = new AbortController();
        setCatalog({ key: catalogKey }); setMoreError('');
        source.list({ project, kind, query: search }, controller.signal).then(result => {
            if (!controller.signal.aborted) setCatalog({ key: catalogKey, page: result });
        }).catch(error => { if (!controller.signal.aborted) setCatalog({ key: catalogKey, error: message(error) }); });
        return () => { controller.abort(); pageRequest.current?.abort(); };
    }, [showingDocs, project, kind, search, revision, source, catalogKey]);
    useEffect(() => {
        if (!showingDocs || !place) return;
        const controller = new AbortController();
        const request: DocumentRequest = { project, generation: place.generation,
            ...(place.nodeId === undefined ? { filePath: place.filePath } : { nodeId: place.nodeId }) };
        source.detail(request, controller.signal).then(result => {
            if (!controller.signal.aborted) setReading({ key: readingKey, detail: result });
        }).catch(error => { if (!controller.signal.aborted) setReading({ key: readingKey, error: message(error) }); });
        return () => controller.abort();
    }, [showingDocs, project, place, source, readingKey]);
    const visit = useCallback((next: Place) => {
        setFocusRevision(value => value + 1);
        setHistory(previous => {
            const current = previous.entries[previous.index];
            if (JSON.stringify(current) === JSON.stringify(next)) return previous;
            const entries = [...previous.entries.slice(0, previous.index + 1), next].slice(-100);
            return { entries, index: entries.length - 1 };
        });
    }, []);
    useEffect(() => {
        if (!openDocument) return;
        setTab('documents');
        visit({ filePath: openDocument.filePath, generation: openDocument.generation,
            line: openDocument.line, page: openDocument.page });
    }, [openDocument, visit]);
    const openNode = (node: DocumentNode) => {
        if (node.project && node.project !== project) return;
        if (isDocumentNode(node)) visit({ nodeId: node.id, generation: detail?.generation ?? page?.generation ?? '',
            ...(node.label === 'Section' || node.label === 'DocumentSection' ? node.location_kind === 'pages'
                ? { page: node.start_line || undefined } : { line: lineOf(node) } : {}) });
        else if (node.file_path) onNavigate(node.file_path, lineOf(node), node.name);
    };
    const followLink = useCallback((filePath: string, anchor: string) => {
        if (!detail) return;
        if (filePath === detail.document.file_path) {
            visit({ nodeId: detail.document.id, generation: detail.generation, anchor });
        } else if (isDocumentPath(filePath) || detail.relationships.some(edge => edge.target.file_path === filePath && isDocumentNode(edge.target))) {
            visit({ filePath, generation: detail.generation, anchor });
        } else {
            // The source drawer resolves this exact path against the project's
            // indexed Module/File nodes before it requests any source bytes.
            const line = /^L([1-9]\d*)(?:-L?[1-9]\d*)?$/i.exec(anchor)?.[1];
            const parsed = line ? Number(line) : undefined;
            onNavigate(filePath, parsed && Number.isSafeInteger(parsed) ? parsed : undefined, filePath.split('/').at(-1));
        }
    }, [detail, visit, onNavigate]);
    const refresh = () => {
        pageRequest.current?.abort(); setMore(false); setMoreError('');
        setHistory({ entries: [], index: -1 }); setReading(undefined); setRevision(value => value + 1);
    };
    const loadMore = async () => {
        if (!page?.next_cursor || more) return;
        const controller = new AbortController(); pageRequest.current = controller;
        setMore(true); setMoreError('');
        try {
            const result = await source.list({ project, kind, query: search, cursor: page.next_cursor }, controller.signal);
            if (controller.signal.aborted || currentKey.current !== catalogKey) return;
            if (result.generation !== page.generation) throw new Error('The index changed. Refresh the catalog.');
            if (result.next_cursor === page.next_cursor) throw new Error('The catalog returned a repeated page. Refresh the catalog.');
            setCatalog({ key: catalogKey, page: { ...result, documents: [...new Map([...page.documents, ...result.documents].map(node => [node.id, node])).values()],
                warnings: [...new Set([...page.warnings, ...result.warnings])] } });
        } catch (error) { if (!controller.signal.aborted && currentKey.current === catalogKey) setMoreError(message(error)); }
        finally { if (currentKey.current === catalogKey) setMore(false); }
    };
    useSelectionEvidence(onSelectionEvidence, detail ? {
        project, generation: detail.generation, view: 'documents', source: 'indexed document projection',
        label: detail.document.name, selected: detail.document, relationships: detail.relationships,
        limitations: { sourceMode: detail.source_mode, sourceStale: detail.source_stale, sourceTruncated: detail.source_truncated, warnings: detail.warnings },
    } : undefined, showingDocs);
    return <section className="docs-workspace" aria-label="Documentation">
        <header className="docs-toolbar"><nav role="tablist" aria-label="Documentation sections">
            <button type="button" role="tab" aria-selected={tab === 'documents'} onClick={() => setTab('documents')}>Documents</button>
            <button type="button" role="tab" aria-selected={tab === 'adr'} onClick={() => setTab('adr')}>Architecture decisions</button>
        </nav><span className="docs-project">{project || 'No project selected'}</span></header>
        <div hidden={tab !== 'adr'} className="docs-adr"><AdrWorkspace project={project} active={active && tab === 'adr'} source={adrSource} /></div>
        <div hidden={tab !== 'documents'} className="docs-layout">
            <aside className="docs-catalog" aria-label="Document catalog">
                <form onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}>
                    <label htmlFor={`${fieldId}-search`}>Find documentation</label>
                    <div className="docs-search"><input id={`${fieldId}-search`} type="search" value={query} placeholder="Title or file path" onChange={event => setQuery(event.target.value)} /><button type="submit">Search</button></div>
                    <label htmlFor={`${fieldId}-kind`}>Document type</label>
                    <select id={`${fieldId}-kind`} value={kind} onChange={event => setKind(event.target.value as DocumentKind | 'all')}>
                        <option value="all">All documents</option>{(['markdown', 'pdf', 'diagram', 'adr', 'other'] as const).map(value => <option key={value} value={value}>{documentKindLabel(value)}</option>)}
                    </select>
                </form>
                <div className="docs-catalog-heading"><span>{page ? `${page.documents.length} documents${page.next_cursor ? ' loaded' : ''}` : 'Indexed documents'}</span><button type="button" onClick={refresh}>Refresh catalog</button></div>
                {!project ? <p>Select a project to browse its indexed documentation.</p> : catalogError ? <p role="alert">{catalogError}</p>
                    : !page ? <p role="status">Reading documentation…</p>
                        : page.documents.length === 0 ? <p role="status">{search || kind !== 'all' ? 'No indexed documents match these filters.' : 'No indexed documents yet. Index the project documentation to browse it here.'}</p>
                            : <ul className="docs-document-list">{page.documents.map(node => <li key={node.id}><button type="button" aria-label={`Open ${node.name}`}
                                aria-current={detail?.document.id === node.id ? 'page' : undefined} onClick={() => visit({ nodeId: node.id, generation: page.generation })}>
                                <strong>{node.name}</strong><span>{node.file_path}</span><small>{documentKindLabel(node.kind)}</small>
                            </button></li>)}</ul>}
                {page?.next_cursor && <button type="button" className="docs-load-more" disabled={more} onClick={() => void loadMore()}>{more ? 'Loading…' : 'Load more documents'}</button>}
                {moreError && <p role="alert">{moreError}</p>}
                {page?.complete === false && !page.next_cursor && <p className="docs-notice">The catalog is incomplete. Refresh or check index coverage.</p>}
                {page?.warnings.map(warning => <p className="docs-notice" key={warning}>{warning}</p>)}
            </aside>
            <main className="docs-reading" aria-busy={Boolean(place && !detail && !readError)}>
                <div className="docs-reader-toolbar"><nav aria-label="Document history">
                    <button type="button" disabled={history.index <= 0} onClick={() => setHistory(previous => ({ ...previous, index: previous.index - 1 }))}>Back</button>
                    <button type="button" disabled={history.index < 0 || history.index >= history.entries.length - 1} onClick={() => setHistory(previous => ({ ...previous, index: previous.index + 1 }))}>Forward</button>
                </nav>{detail && (!detail.document.location_kind || detail.document.location_kind === 'lines') && detail.document.kind !== 'pdf'
                    && <button type="button" onClick={() => onNavigate(detail.document.file_path, lineOf(detail.document), detail.document.name)}>Open source</button>}</div>
                {!place ? <div className="docs-empty"><h2>Documentation, connected to its source.</h2><p>Choose a document to read it alongside the sections, links and code relationships recorded in your index.</p></div>
                    : readError ? <div className="docs-empty" role="alert"><p>{readError}</p><button type="button" onClick={() => setReadRevision(value => value + 1)}>Try again</button><button type="button" onClick={refresh}>Refresh catalog</button></div>
                        : !detail ? <p className="docs-loading" role="status">Reading document…</p> : <>
                            <header className="docs-document-heading"><h1>{detail.document.name}</h1><p>{documentLocation(detail.document)}</p></header>
                            {detail.source_mode === 'extracted' && <p className="docs-notice">Text extracted by the index. Page numbers refer to the source document; original layout is not reproduced.</p>}
                            {detail.source_stale && <p className="docs-notice" role="status">The local document changed after indexing. Relationships refer to the indexed version.</p>}
                            {detail.source_truncated && <p className="docs-notice" role="status">Only part of this document is available in this view.</p>}
                            {detail.warnings.map(warning => <p className="docs-notice" key={warning}>{warning}</p>)}
                            <DocumentReader detail={detail} anchor={place.anchor} line={place.line} page={place.page}
                                focusRevision={focusRevision} onLink={followLink} />
                        </>}
            </main>
            <aside ref={connections} className="docs-connections" aria-label="Document relationships">
                <h2>Connected evidence</h2>
                {!detail ? <p>Sections and recorded relationships appear here when you open a document.</p> : <>
                    <DocumentationGraph key={`${detail.generation}:${detail.document.id}`} detail={detail} onOpen={openNode} onEvidence={edge => {
                        const row = connections.current?.querySelector<HTMLElement>(`[data-document-relation="${edge.id}:${edge.direction}"]`);
                        row?.scrollIntoView?.({ block: 'nearest' }); row?.focus({ preventScroll: true });
                    }} />
                    {detail.sections.length > 0 && <section><h3>Sections</h3><ul>{detail.sections.map(section => <li key={section.id}>
                        <button type="button" onClick={() => openNode(section)}>{section.name}<small>{section.location_kind === 'pages' ? 'Page ' : 'Line '}{section.start_line || 'unknown'}</small></button>
                    </li>)}</ul></section>}
                    <section><h3>Graph relationships <span>{detail.relationships.length}</span></h3>
                        {detail.relationships.length === 0 ? <p>No graph relationships were recorded for this document.</p> : <ul>{detail.relationships.map((edge, index) => <li key={`${edge.id}:${edge.direction}:${index}`} className="docs-relation"
                            data-document-relation={`${edge.id}:${edge.direction}`} tabIndex={-1}>
                            <span className="docs-relation-type">{edge.direction === 'incoming' ? 'Incoming' : 'Outgoing'} · {edge.type.replaceAll('_', ' ')}</span>
                            <button type="button" disabled={Boolean(edge.target.project && edge.target.project !== project)} aria-label={isDocumentNode(edge.target) ? `Open related ${edge.target.name}` : `Open source for ${edge.target.name}`}
                                onClick={() => openNode(edge.target)}><strong>{edge.target.name}</strong><small>{documentLocation(edge.target)}</small></button>
                            {edge.evidence && <><button type="button" className="docs-evidence-link" onClick={() => {
                                const evidence = edge.evidence!;
                                if (evidence.page) {
                                    visit({ filePath: evidence.file_path, generation: detail.generation, page: evidence.page });
                                } else if (/\.pdf$/i.test(evidence.file_path)) followLink(evidence.file_path, '');
                                else onNavigate(evidence.file_path, evidence.line || undefined,
                                    `${edge.type} ${evidence.line ? 'evidence' : 'source file'}`);
                            }}>{edge.evidence.position_kind === 'source_context' ? 'Open source section' : edge.evidence.page || edge.evidence.line ? 'View relationship source' : 'Open source file'}{edge.evidence.page ? ` · page ${edge.evidence.page}` : edge.evidence.line ? `:${edge.evidence.line}` : ''}</button>
                            {edge.evidence.position_kind === 'source_context' && <small>Showing the source section; the relationship position was not recorded.</small>}
                            {!edge.evidence.page && !edge.evidence.line && <small>Relationship location was not recorded.</small>}</>}
                            {edge.target.project && edge.target.project !== project && <small>In project {edge.target.project}</small>}
                        </li>)}</ul>}
                    </section>
                </>}
            </aside>
        </div>
    </section>;
}
export default function DocumentsWorkspace(props: DocumentsWorkspaceProps) {
    return <ProjectDocuments key={props.project} {...props} />;
}
