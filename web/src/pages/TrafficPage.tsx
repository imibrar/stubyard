import { useSearchParams } from 'react-router-dom';
import { TrafficLog } from '../components/TrafficLog';
import { PageHeader } from '../components/layout';

export default function TrafficPage() {
  const [params] = useSearchParams();
  return (
    <>
      <PageHeader title="Traffic log" description="Every request stubyard received or sent, across all projects, including errors and requests to unknown URLs." />
      <div className="card log-card">
        <TrafficLog initialOpenId={params.get('log')} />
      </div>
    </>
  );
}
