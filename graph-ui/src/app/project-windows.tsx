/**
 * Ein Projektwechsel bleibt in der Seite (K24).
 *
 * Bis K24 lud ein Wechsel die ganze Seite neu, weil jedes Panel dieses Fensters
 * an das Projekt gebunden ist, mit dem es startete. Mit dem Neuladen gingen der
 * Worker des lokalen Agenten und seine Gewichte mit, und die Lampe stand
 * sekundenlang auf "loading". Jetzt bekommt jedes Projekt ein frisches Fenster:
 * derselbe Baum unter einem neuen Schluessel, also frischer Zustand in jedem
 * Panel wie nach einem Neuladen, aber ohne die Seite zu verlassen.
 *
 * Drei Entscheidungen:
 *
 * 1. **Ein neuer Schluessel statt eines Zuruecksetzens.** Das Fenster haelt
 *    rund hundert Zustaende, und jeder vergessene waere eine Anzeige des alten
 *    Projekts im neuen. Ein neuer Schluessel vergisst keinen. Was das alte
 *    Fenster dem neuen mitgibt, meldet es ausdruecklich (`report`), und nur
 *    das kommt an (`carried`).
 * 2. **Die Adresse wechselt mit pushState.** Zurueck und Vor des Browsers
 *    wechseln das Projekt ebenso in der Seite (popstate); ein popstate, das das
 *    Projekt behaelt, laesst das Fenster stehen.
 * 3. **Das alte Fenster ist weg, wenn der Wechsel endet.** Der Wechsel wird mit
 *    flushSync festgeschrieben, innerhalb des Rahmens `around`, in dem der
 *    Agent sein Modell weiterreicht (browser-ai/agent-handover.ts). Danach
 *    bricht das Signal des alten Fensters ab: was es noch fragt, geht nicht
 *    mehr hinaus, und was noch antwortet, landet in einem ausgehaengten Baum.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { projectHref } from '../projects/projects-model';

/** Das Projekt aus `?project=`, leer, wenn die Adresse keins nennt. */
export function projectOfLocation(search = window.location.search): string {
    return new URLSearchParams(search).get('project') ?? '';
}

export interface ProjectWindow<C> {
    /** Wechselt mit jedem Projekt; als React-Schluessel des Fensters gedacht. */
    key: number;
    /** Das Projekt der Adresse beim Oeffnen des Fensters, leer ohne `?project=`. */
    project: string;
    /** Bricht ab, sobald ein anderes Projekt das Fenster ersetzt hat. */
    signal: AbortSignal;
    /** Was das vorige Fenster zuletzt gemeldet hat. */
    carried?: C;
    /** Oeffnet ein anderes Projekt in dieser Seite. */
    open: (project: string) => void;
    /** Meldet, was ein naechstes Fenster mitbekommen soll. */
    report: (carry: C) => void;
}

interface Shown<C> { key: number; project: string; controller: AbortController; carried?: C }

export function ProjectWindows<C>({ children, around = commit => commit() }: {
    children: (window: ProjectWindow<C>) => ReactNode;
    around?: (commit: () => void) => void;
}): JSX.Element {
    const [shown, setShown] = useState<Shown<C>>(() => ({ key: 0, project: projectOfLocation(), controller: new AbortController() }));
    const current = useRef(shown); current.current = shown;
    const carry = useRef<C | undefined>(undefined);
    const show = useCallback((project: string) => {
        const previous = current.current;
        if (project === previous.project) return;
        const next: Shown<C> = { key: previous.key + 1, project, controller: new AbortController(), ...carry.current === undefined ? {} : { carried: carry.current } };
        current.current = next;
        around(() => flushSync(() => setShown(next)));
        previous.controller.abort();
    }, [around]);
    const open = useCallback((project: string) => {
        if (project === current.current.project) return;
        window.history.pushState(null, '', projectHref(project));
        show(project);
    }, [show]);
    const report = useCallback((value: C) => { carry.current = value; }, []);
    useEffect(() => {
        const back = () => show(projectOfLocation());
        window.addEventListener('popstate', back);
        return () => window.removeEventListener('popstate', back);
    }, [show]);
    return <>{children({ key: shown.key, project: shown.project, signal: shown.controller.signal, carried: shown.carried, open, report })}</>;
}
