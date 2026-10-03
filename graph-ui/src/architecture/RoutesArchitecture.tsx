import { lazy, Suspense, useState, type ComponentProps } from 'react';
import SpatialArchitecture from './SpatialArchitecture';
import './container-map.css';
const ContainerMap = lazy(() => import('./ContainerMap'));

/** The endpoint graph remains available independently of deployment metadata. */
export default function RoutesArchitecture(props: ComponentProps<typeof SpatialArchitecture>) {
    const [mode, setMode] = useState<'services' | 'endpoints'>('services');
    const show = (next: 'services' | 'endpoints') => { if (mode !== next) props.onSelectionEvidence?.(undefined); setMode(next); };
    return <><nav className="container-mode" aria-label="Routes perspective">
        <button aria-pressed={mode === 'services'} onClick={() => show('services')}>Service map</button>
        <button aria-pressed={mode === 'endpoints'} onClick={() => show('endpoints')}>Endpoints</button>
    </nav>{mode === 'services' ? <Suspense fallback={<p role="status">Preparing service map…</p>}><ContainerMap
        project={props.project} generation={props.generation} active={props.active} filter={props.filter} onNavigate={props.onNavigate} onClearSelection={props.onClearSelection} onSelectionEvidence={props.onSelectionEvidence}
        onShowEndpoints={() => show('endpoints')} /></Suspense>
        : <SpatialArchitecture {...props} />}</>;
}
