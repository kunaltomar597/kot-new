import { Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router';
import { OrderEntry } from './OrderEntry.js';
import { TableOverview } from './TableOverview.js';

/**
 * The POS mode (P1-08): the live floor, order entry for a table, and takeaway. Paths are relative
 * to `/pos`.
 */
export function PosHome() {
  return (
    <Routes>
      <Route index element={<TableOverview />} />
      <Route path="table/:sessionId" element={<TableOrder />} />
      <Route path="takeaway" element={<TakeawayOrder />} />
    </Routes>
  );
}

function TableOrder() {
  const { sessionId = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  return (
    <OrderEntry
      key={sessionId}
      target={{ kind: 'table', sessionId, label: search.get('label') ?? '' }}
      onBack={() => {
        void navigate('/pos');
      }}
    />
  );
}

function TakeawayOrder() {
  const navigate = useNavigate();
  return (
    <OrderEntry
      target={{ kind: 'takeaway' }}
      onBack={() => {
        void navigate('/pos');
      }}
    />
  );
}
