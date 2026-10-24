import { RequestCatalogueCard } from './cards/RequestCatalogue';
import { SsoAdminSection } from './cards/SsoAdmin';
import { AiAdminSection } from '../../components/Ai';
import { DevSourcesSection } from '../../components/DevLinks';
import { StatusPageAdmin } from './cards/StatusPageAdmin';
import { isManager, useSession } from '../../session';
import { ConnectorsCard } from './cards/Connectors';
import { Link } from 'react-router';
import { UsersCard } from './cards/UsersCard';
import { CategoriesCard } from './cards/CategoriesCard';
import { BackupsCard } from './cards/BackupsCard';
import { SystemsCard } from './cards/SystemsCard';
import { WebhooksCard } from './cards/WebhooksCard';
import { SecurityCard } from './cards/SecurityCard';
import { ModulesCard } from './cards/ModulesCard';
import { StartPagesCard } from './cards/StartPagesCard';
import { TemplatesCard } from './cards/TemplatesCard';

export function AdminPage() {
  const { user, meta } = useSession();
  if (!isManager(user)) return <p className="empty">Administration requires the Manager or Administrator role.</p>;
  return (
    <>
      <header className="page-head">
        <h1>Administration</h1>
        {user.role === 'admin' && (
          <div className="head-actions">
            <Link className="btn" to="/admin/security-events">Security events</Link>
            <Link className="btn" to="/admin/audit">Audit trail</Link>
          </div>
        )}
      </header>
      {user.role === 'admin' && <ModulesCard />}
      {user.role === 'admin' && <StartPagesCard />}
      {user.role === 'admin' && <SecurityCard />}
      {user.role === 'admin' && <WebhooksCard />}
      {user.role === 'admin' && (meta.modules?.cmdb !== false || meta.modules?.incident !== false) && <ConnectorsCard />}
      {meta.modules?.change !== false && <DevSourcesSection />}
      {user.role === 'admin' && <SsoAdminSection />}
      <AiAdminSection />
      <StatusPageAdmin />
      <SystemsCard />
      <BackupsCard />
      {user.role === 'admin' && <UsersCard />}
      <CategoriesCard />
      <TemplatesCard />
      {meta.modules?.request && <RequestCatalogueCard />}
    </>
  );
}
