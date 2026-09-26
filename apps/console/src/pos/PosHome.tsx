import { Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router';
import { BillScreen } from '../billing/BillScreen.js';
import { DayEndScreen } from '../billing/DayEndScreen.js';
import { PaymentScreen } from '../billing/PaymentScreen.js';
import { ShiftScreen } from '../billing/ShiftScreen.js';
import { OrderEntry } from './OrderEntry.js';
import { TableOverview } from './TableOverview.js';

/**
 * The POS mode (P1-08, P1-12): the live floor, order entry for a table and takeaway, bills,
 * payments and the cashier's shift. Paths are relative to `/pos`.
 */
export function PosHome() {
  return (
    <Routes>
      <Route index element={<TableOverview />} />
      <Route path="table/:sessionId" element={<TableOrder />} />
      <Route path="takeaway" element={<TakeawayOrder />} />
      <Route path="shift" element={<Shift />} />
      <Route path="day-end" element={<DayEnd />} />
      <Route path="bill/:billId" element={<Bill />} />
      <Route path="pay/:invoiceId" element={<Pay />} />
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

function Shift() {
  const navigate = useNavigate();
  return (
    <ShiftScreen
      onBack={() => {
        void navigate('/pos');
      }}
    />
  );
}

function Bill() {
  const { billId = '' } = useParams();
  const navigate = useNavigate();
  return (
    <BillScreen
      key={billId}
      billId={billId}
      onBack={() => {
        void navigate('/pos');
      }}
      onPay={(invoiceId) => {
        void navigate(`/pos/pay/${invoiceId}?bill=${billId}`);
      }}
    />
  );
}

function Pay() {
  const { invoiceId = '' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const bill = search.get('bill');
  const back = () => {
    void navigate(bill === null ? '/pos' : `/pos/bill/${bill}`);
  };
  return (
    <PaymentScreen
      key={invoiceId}
      invoiceId={invoiceId}
      onBack={back}
      onDone={back}
      onOpenShift={() => {
        void navigate('/pos/shift');
      }}
    />
  );
}

function DayEnd() {
  const navigate = useNavigate();
  return (
    <DayEndScreen
      onBack={() => {
        void navigate('/pos');
      }}
    />
  );
}
