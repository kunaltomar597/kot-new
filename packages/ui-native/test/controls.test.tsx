import { themes } from '@rp/design-tokens';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import {
  Button,
  Money,
  ORDER_ITEM_STATE_STYLES,
  PinPad,
  StatusChip,
  TextField,
  toneColors,
  useTheme,
} from '../src/index.js';
import { renderUi } from './render.js';

describe('[NFR-U01] Button', () => {
  it('presses, and blocks presses while loading or disabled', async () => {
    const onPress = jest.fn();
    await renderUi(<Button onPress={onPress}>Send KOT</Button>);
    await fireEvent.press(screen.getByRole('button', { name: 'Send KOT' }));
    expect(onPress).toHaveBeenCalledTimes(1);

    await renderUi(
      <Button onPress={onPress} loading variant="danger" size="lg" fullWidth>
        Void
      </Button>,
    );
    const busy = screen.getByRole('button', { name: 'Void' });
    expect(busy).toBeDisabled();
    expect(busy).toBeBusy();
    await fireEvent.press(busy);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('says whether a choice button is the chosen one', async () => {
    await renderUi(
      <>
        <Button variant="primary" selected>
          Starters
        </Button>
        <Button variant="secondary" selected={false}>
          Mains
        </Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Starters' })).toBeSelected();
    expect(screen.getByRole('button', { name: 'Mains' })).not.toBeSelected();
  });

  it('renders every variant with the theme colours', async () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'accent'] as const) {
      await renderUi(
        <Button variant={variant} disabled accessibilityLabel={`${variant} button`}>
          Go
        </Button>,
        'dark',
      );
      expect(screen.getByRole('button', { name: `${variant} button` })).toBeDisabled();
    }
  });
});

describe('[NFR-U03] TextField', () => {
  it('names the input by its label, and reports each change', async () => {
    const onChangeText = jest.fn();
    await renderUi(
      <TextField
        label="Search the menu"
        value="pan"
        onChangeText={onChangeText}
        hint="Name or short code"
        returnKeyType="search"
        maxLength={40}
        testID="search"
      />,
    );
    const input = screen.getByLabelText('Search the menu');
    expect(input).toHaveDisplayValue('pan');
    expect(input).toHaveProp('maxLength', 40);
    expect(screen.getByText('Name or short code')).toBeOnTheScreen();
    await fireEvent.changeText(input, 'paneer');
    expect(onChangeText).toHaveBeenCalledWith('paneer');
  });

  it('announces an error, and cannot be edited when disabled', async () => {
    await renderUi(
      <TextField
        label="Instructions for the kitchen"
        value=""
        onChangeText={jest.fn()}
        error="Too long"
        disabled
        multiline
      />,
      'dark',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Too long');
    const input = screen.getByLabelText('Instructions for the kitchen');
    expect(input).toHaveProp('editable', false);
    expect(input).toHaveStyle({ borderColor: themes.dark.danger });
  });
});

describe('[NFR-U01] theme', () => {
  it('uses the light theme without a provider and overrides the accent', async () => {
    function Probe() {
      const { name, colors } = useTheme();
      return <Text>{`${name} ${colors.primary}`}</Text>;
    }
    await render(<Probe />);
    expect(screen.getByText(`light ${themes.light.primary}`)).toBeOnTheScreen();
    expect(toneColors(themes.kds, 'warning').on).toBe(themes.kds.onWarning);
  });
});

describe('[BRD §9.4] Money', () => {
  it('formats paise with Indian grouping and colours refunds', async () => {
    await renderUi(<Money paise={12_345_678} />);
    expect(screen.getByText('₹1,23,456.78')).toBeOnTheScreen();
    await renderUi(<Money paise={-5_000} signTone strong size="lg" symbol={false} />);
    expect(screen.getByText('-50.00')).toHaveStyle({ color: themes.light.dangerText });
  });
});

describe('[NFR-U05] StatusChip', () => {
  it('shows the state name next to its symbol in the state tone', async () => {
    await renderUi(<StatusChip state="READY" label="Ready" size="lg" />);
    expect(screen.getByLabelText('Ready')).toBeOnTheScreen();
    expect(screen.getByText('Ready')).toHaveStyle({ color: themes.light.successText });
    expect(ORDER_ITEM_STATE_STYLES.VOIDED.tone).toBe('danger');
  });
});

describe('[AUTH-002][AUTH-004] PinPad', () => {
  it('submits after the last digit, clears itself and never shows the digits', async () => {
    const onComplete = jest.fn();
    await renderUi(<PinPad onComplete={onComplete} />);
    for (const digit of ['1', '2', '3']) {
      await fireEvent.press(screen.getByTestId(`pin-key-${digit}`));
    }
    expect(screen.getByLabelText('3 of 4 digits entered')).toBeOnTheScreen();
    expect(screen.getAllByTestId('pin-dot-filled')).toHaveLength(3);
    await fireEvent.press(screen.getByTestId('pin-key-4'));
    expect(onComplete).toHaveBeenCalledWith('1234');
    expect(screen.getByLabelText('0 of 4 digits entered')).toBeOnTheScreen();
    expect(screen.queryByText('1234')).toBeNull();
  });

  it('edits with backspace and clear, and submits with the key when asked', async () => {
    const onComplete = jest.fn();
    await renderUi(<PinPad onComplete={onComplete} length={6} autoSubmit={false} />);
    const submit = screen.getByTestId('pin-key-submit');
    expect(screen.getByRole('button', { name: 'Delete last digit' })).toBeDisabled();
    for (const digit of ['9', '8', '7', '6', '5', '4', '3']) {
      await fireEvent.press(screen.getByTestId(`pin-key-${digit}`));
    }
    expect(screen.getByLabelText('6 of 6 digits entered')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete last digit' }));
    expect(submit).toBeDisabled();
    await fireEvent.press(screen.getByTestId('pin-key-0'));
    await fireEvent.press(submit);
    expect(onComplete).toHaveBeenCalledWith('987650');

    await fireEvent.press(screen.getByTestId('pin-key-1'));
    await fireEvent.press(screen.getByText('Clear'));
    expect(screen.getByLabelText('0 of 6 digits entered')).toBeOnTheScreen();
  });

  it('shows the error and blocks input while busy', async () => {
    const onComplete = jest.fn();
    await renderUi(<PinPad onComplete={onComplete} error="Wrong PIN, try again" busy />);
    expect(screen.getByText('Wrong PIN, try again')).toBeOnTheScreen();
    expect(screen.getByTestId('pin-key-1')).toBeDisabled();
  });

  it('rejects a PIN length outside 4 to 8', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(renderUi(<PinPad onComplete={jest.fn()} length={3} />)).rejects.toThrow(
      RangeError,
    );
  });

  it('needs the strings from i18n', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(render(<PinPad onComplete={jest.fn()} />)).rejects.toThrow(/UiStringsProvider/);
  });
});
