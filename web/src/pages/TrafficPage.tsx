import { useSearchParams } from 'react-router-dom';
import { TrafficLog } from '../components/TrafficLog';

export default function TrafficPage() {
  const [params] = useSearchParams();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Traffic log</h1>
          <p>Every request stubyard received or sent, across all projects, including errors and requests to unknown URLs.</p>
        </div>
      </div>
      <div className="card">
        <TrafficLog initialOpenId={params.get('log')} />
      </div>
    </>
  );
}
