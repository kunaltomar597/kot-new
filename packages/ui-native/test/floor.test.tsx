import { themes } from '@rp/design-tokens';
import { fireEvent, screen } from '@testing-library/react-native';
import { SegmentedControl, TABLE_STATE_STYLES, TableTile } from '../src/index.js';
import { renderUi } from './render.js';

describe('[WTR-002] [NFR-U05] TableTile', () => {
  it('reads label, state, details, amount and alert in order, and opens on press', async () => {
    const onPress = jest.fn();
    await renderUi(
      <TableTile
        label="T4"
        state="OCCUPIED"
        stateLabel="Occupied"
        details={['3 guests', '25 min', 'Ravi']}
        amountSoFar={84_000}
        alert="2 to approve"
        onPress={onPress}
        testID="tile"
      />,
    );
    const tile = screen.getByRole('button', {
      name: 'T4, Occupied, 3 guests, 25 min, Ravi, ₹840.00, 2 to approve',
    });
    expect(screen.getByText('Occupied')).toHaveStyle({ color: themes.light.infoText });
    expect(screen.getByText('3 guests · 25 min · Ravi')).toBeOnTheScreen();
    await fireEvent.press(tile);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows a free table with just its state, and is a summary without an action', async () => {
    await renderUi(<TableTile label="T1" state="FREE" stateLabel="Free" />, 'dark');
    expect(screen.getByLabelText('T1, Free')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Free')).toHaveStyle({ color: themes.dark.successText });
    expect(TABLE_STATE_STYLES.BILL_REQUESTED.tone).toBe('warning');
  });
});

describe('[NFR-U01] SegmentedControl', () => {
  it('marks the chosen view and reports a change only when another is chosen', async () => {
    const onChange = jest.fn();
    await renderUi(
      <SegmentedControl
        label="Which tables to show"
        options={[
          { id: 'mine', label: 'My tables' },
          { id: 'all', label: 'All tables' },
        ]}
        value="mine"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('tab', { name: 'My tables' })).toBeSelected();
    expect(screen.getByRole('tab', { name: 'All tables' })).not.toBeSelected();
    await fireEvent.press(screen.getByRole('tab', { name: 'My tables' }));
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('tab', { name: 'All tables' }));
    expect(onChange).toHaveBeenCalledWith('all');
  });
});
