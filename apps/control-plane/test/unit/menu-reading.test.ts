import { describe, expect, it } from 'vitest';
import {
  AnthropicMenuExtractor,
  ExtractionError,
  type ExtractionFile,
} from '../../src/menu-import/menu-extractor.js';
import { draftFromReading, paiseOf } from '../../src/menu-import/menu-reading.js';

const reading = {
  found_menu: true,
  sections: [
    {
      name: '  Starters ',
      dishes: [
        {
          name: 'Paneer Tikka',
          description: 'Cottage cheese, char-grilled',
          price: '₹ 1,249/-',
          sizes: [],
          food_type: 'veg',
          spice_level: 2,
          tags: ['Chef special', 'Chef special'],
          unsure: null,
        },
        {
          name: 'Chicken Biryani',
          description: null,
          price: null,
          sizes: [
            { name: 'Half', price: '220' },
            { name: 'Full', price: 'Rs. 399.5' },
          ],
          food_type: 'non_veg',
          spice_level: 7,
          tags: [],
          unsure: 'The full price is smudged',
        },
        { name: 'Masala Papad', price: null, sizes: [], food_type: 'something' },
        { name: '   ', price: '10', sizes: [], food_type: null },
      ],
    },
    { name: 'Empty', dishes: [] },
  ],
  add_ons: [{ group: 'Extras', options: [{ name: 'Cheese', price: '40' }, { name: 'x' }] }],
  notes: ['Page 2 was cut off'],
};

describe('[ONB-006] reading what the AI provider recorded', () => {
  it('turns printed rupees into paise without floating point', () => {
    expect(paiseOf('249')).toBe(24_900);
    expect(paiseOf('249.50')).toBe(24_950);
    expect(paiseOf('Rs. 85.5')).toBe(8_550);
    expect(paiseOf('₹ 1,249/-')).toBe(124_900);
    expect(paiseOf(0.29)).toBe(29);
    expect(paiseOf('free')).toBeUndefined();
    expect(paiseOf(null)).toBeUndefined();
  });

  it('makes a draft of every section and dish, as printed, for a person to check', () => {
    const draft = draftFromReading(reading);
    expect(draft?.categories).toHaveLength(1);
    expect(draft?.categories[0]?.name).toBe('Starters');
    expect(draft?.categories[0]?.items).toEqual([
      {
        name: 'Paneer Tikka',
        description: 'Cottage cheese, char-grilled',
        price: 124_900,
        variants: [],
        foodType: 'VEG',
        spiceLevel: 2,
        tags: ['Chef special'],
        note: null,
      },
      {
        name: 'Chicken Biryani',
        description: null,
        price: null,
        variants: [
          { name: 'Half', price: 22_000 },
          { name: 'Full', price: 39_950 },
        ],
        foodType: 'NON_VEG',
        spiceLevel: null,
        tags: [],
        note: 'The full price is smudged',
      },
      {
        name: 'Masala Papad',
        description: null,
        price: null,
        variants: [],
        foodType: null,
        spiceLevel: null,
        tags: [],
        note: 'No price found.',
      },
    ]);
    expect(draft?.addOns).toEqual([
      { group: 'Extras', options: [{ name: 'Cheese', price: 4_000 }] },
    ]);
    expect(draft?.notes).toEqual(['Page 2 was cut off']);
  });

  it('finds no menu when there is none', () => {
    expect(draftFromReading({ ...reading, found_menu: false })).toBeUndefined();
    expect(
      draftFromReading({ found_menu: true, sections: [], add_ons: [], notes: [] }),
    ).toBeUndefined();
    expect(draftFromReading('nonsense')).toBeUndefined();
  });

  it('keeps an overlong reading within the draft’s limits', () => {
    const long = draftFromReading({
      found_menu: true,
      sections: [
        {
          name: 'S',
          dishes: [
            {
              name: 'D'.repeat(200),
              price: '10',
              sizes: [],
              food_type: null,
              description: 'x'.repeat(900),
            },
          ],
        },
      ],
      add_ons: [],
      notes: [],
    });
    expect(long?.categories[0]?.items[0]?.name).toHaveLength(80);
    expect(long?.categories[0]?.items[0]?.description).toHaveLength(500);
  });
});

describe('[ONB-006] [SEC-002] asking the AI provider', () => {
  const files: ExtractionFile[] = [
    { name: 'page1.jpg', contentType: 'image/jpeg', content: new Uint8Array([1, 2, 3]) },
    { name: 'menu.pdf', contentType: 'application/pdf', content: new Uint8Array([4, 5]) },
  ];
  const calls: { url: string; body: string; headers: unknown }[] = [];
  const answering = (status: number, body: unknown): typeof fetch => {
    return (url, init) => {
      calls.push({
        url: url instanceof Request ? url.url : url.toString(),
        body: typeof init?.body === 'string' ? init.body : '',
        headers: init?.headers,
      });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
  };
  const extractor = (fetchImpl: typeof fetch) =>
    new AnthropicMenuExtractor({
      apiKey: 'test-key-not-real',
      model: 'claude-sonnet-5-5',
      baseUrl: 'https://api.anthropic.example/',
      timeoutMs: 1_000,
      fetch: fetchImpl,
    });

  it('sends every file and forces the record_menu tool, with the key in a header only', async () => {
    calls.length = 0;
    const output = await extractor(
      answering(200, {
        model: 'claude-sonnet-5-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'record_menu', input: reading }],
        usage: { input_tokens: 1_800, output_tokens: 600 },
      }),
    ).extract(files);
    expect(output).toMatchObject({
      model: 'claude-sonnet-5-5',
      inputTokens: 1_800,
      outputTokens: 600,
    });
    expect(output.draft.categories[0]?.items).toHaveLength(3);
    const call = calls[0];
    expect(call?.url).toBe('https://api.anthropic.example/v1/messages');
    expect(call?.headers).toMatchObject({
      'x-api-key': 'test-key-not-real',
      'anthropic-version': '2023-06-01',
    });
    const body = JSON.parse(call?.body ?? '') as {
      tool_choice: unknown;
      messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[];
    };
    expect(call?.body).not.toContain('test-key-not-real');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_menu' });
    expect(body.messages[0]?.content.map((block) => block.type)).toEqual([
      'image',
      'document',
      'text',
    ]);
    expect(body.messages[0]?.content[0]?.source).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'AQID',
    });
  });

  it('says to try later when the provider is busy, and why when it cannot read the files', async () => {
    const busy = await extractor(answering(529, { type: 'error' }))
      .extract(files)
      .catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(ExtractionError);
    expect(busy).toMatchObject({ code: 'AI_PROVIDER_FAILED', retryable: true });
    const refused = await extractor(answering(400, {}))
      .extract(files)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'AI_PROVIDER_FAILED', retryable: false });
    const tooLong = await extractor(answering(200, { stop_reason: 'max_tokens', content: [] }))
      .extract(files)
      .catch((error: unknown) => error);
    expect(tooLong).toMatchObject({ retryable: false });
    expect((tooLong as Error).message).toMatch(/in parts/);
    const nothing = await extractor(
      answering(200, {
        content: [
          {
            type: 'tool_use',
            name: 'record_menu',
            input: { found_menu: false, sections: [], add_ons: [], notes: [] },
          },
        ],
      }),
    )
      .extract(files)
      .catch((error: unknown) => error);
    expect(nothing).toMatchObject({ code: 'AI_NO_MENU_FOUND', retryable: false });
    const offline = await extractor(() => Promise.reject(new Error('ECONNRESET')))
      .extract(files)
      .catch((error: unknown) => error);
    expect(offline).toMatchObject({ code: 'AI_PROVIDER_FAILED', retryable: true });
  });
});
