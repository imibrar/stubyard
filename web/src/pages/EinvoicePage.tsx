import { Link } from 'react-router-dom';
import { providersPath } from '../components/providerLayout';
import { Empty } from '../components/ui';
import { useProject } from '../context';
import { Page } from './ProjectPage';

/** /p/:slug/einvoice — fake ZATCA invoices, onboarding, chains, faults, checks and connect (placeholder until S21). */
export default function EinvoicePage() {
  const { slug } = useProject();
  return (
    <Page title="E-invoicing" description="Fake ZATCA Fatoora: invoices, CSIDs, ICV / PIH chains, faults and integration checks.">
      <div className="card">
        <Empty title="Coming soon">
          <p className="small muted">The invoices, onboarding, chains, faults and checks views are coming in the next update.</p>
          <Link className="btn" to={providersPath(slug, 'einvoice')}>
            Instances in Providers
          </Link>
        </Empty>
      </div>
    </Page>
  );
}
