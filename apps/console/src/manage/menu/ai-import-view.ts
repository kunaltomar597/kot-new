import type { AiMenuImportView, MenuReviewRequest } from '@rp/contracts';
import { type FOOD_TYPES, newKey, paiseOf, rupeesText } from './menu-view.js';

type MenuDraft = NonNullable<AiMenuImportView['draft']>;

/**
 * The review of an AI-read menu (P6-04b, ONB-006): the draft as editable form state, what is
 * still wrong with each dish, and the request once every dish is checked. A printed menu cannot
 * say which station cooks a dish or its tax group, so each section gets both (the restaurant's
 * defaults to begin with).
 */

export type FoodTypeChoice = (typeof FOOD_TYPES)[number] | '';

export interface ReviewDish {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Rupees as typed; blank when the sizes carry the prices. */
  readonly price: string;
  readonly variants: readonly {
    readonly key: string;
    readonly name: string;
    readonly price: string;
  }[];
  readonly foodType: FoodTypeChoice;
  readonly spiceLevel: number;
  readonly tags: readonly string[];
  /** What the reader was unsure of. */
  readonly note: string | null;
  readonly checked: boolean;
}

export interface ReviewSection {
  readonly key: string;
  readonly name: string;
  readonly stationId: string;
  readonly taxGroupId: string;
  readonly dishes: readonly ReviewDish[];
}

export interface ReviewState {
  readonly sections: readonly ReviewSection[];
  readonly addOns: MenuDraft['addOns'];
  readonly notes: readonly string[];
}

export type DishProblem = 'NAME' | 'PRICE' | 'FOOD_TYPE';

export function reviewOf(
  draft: MenuDraft,
  defaults: { readonly stationId: string; readonly taxGroupId: string },
): ReviewState {
  return {
    sections: draft.categories.map((category) => ({
      key: newKey(),
      name: category.name,
      stationId: defaults.stationId,
      taxGroupId: defaults.taxGroupId,
      dishes: category.items.map((item) => ({
        key: newKey(),
        name: item.name,
        description: item.description ?? '',
        price: item.price === null ? '' : rupeesText(item.price),
        variants: item.variants.map((variant) => ({
          key: newKey(),
          name: variant.name,
          price: rupeesText(variant.price),
        })),
        foodType: item.foodType ?? '',
        spiceLevel: item.spiceLevel ?? 0,
        tags: item.tags,
        note: item.note,
        checked: false,
      })),
    })),
    addOns: draft.addOns,
    notes: draft.notes,
  };
}

/** What must be fixed before a dish can be imported (the template's own checks follow). */
export function dishProblems(dish: ReviewDish): DishProblem[] {
  const problems: DishProblem[] = [];
  if (dish.name.trim() === '') problems.push('NAME');
  const sized = dish.variants.length > 0;
  const priced = dish.price.trim() === '' ? sized : paiseOf(dish.price) !== undefined;
  const sizesPriced = dish.variants.every(
    (variant) => variant.name.trim() !== '' && paiseOf(variant.price) !== undefined,
  );
  if (!priced || !sizesPriced) problems.push('PRICE');
  if (dish.foodType === '') problems.push('FOOD_TYPE');
  return problems;
}

export function reviewProgress(state: ReviewState): { checked: number; total: number } {
  const dishes = state.sections.flatMap((section) => section.dishes);
  return { checked: dishes.filter((dish) => dish.checked).length, total: dishes.length };
}

/** Every dish checked and complete, every section with a station and tax group. */
export function readyToImport(state: ReviewState): boolean {
  const { checked, total } = reviewProgress(state);
  return (
    total > 0 &&
    checked === total &&
    state.sections.every(
      (section) =>
        section.stationId !== '' &&
        section.taxGroupId !== '' &&
        section.dishes.every((dish) => dishProblems(dish).length === 0),
    )
  );
}

export function updateDish(
  state: ReviewState,
  dishKey: string,
  change: Partial<Omit<ReviewDish, 'key'>>,
): ReviewState {
  return {
    ...state,
    sections: state.sections.map((section) => ({
      ...section,
      dishes: section.dishes.map((dish) => (dish.key === dishKey ? { ...dish, ...change } : dish)),
    })),
  };
}

export function updateSection(
  state: ReviewState,
  sectionKey: string,
  change: Partial<Pick<ReviewSection, 'name' | 'stationId' | 'taxGroupId'>>,
): ReviewState {
  return {
    ...state,
    sections: state.sections.map((section) =>
      section.key === sectionKey ? { ...section, ...change } : section,
    ),
  };
}

/** Marks every dish of a section checked: the manager has looked at the whole section. */
export function checkSection(state: ReviewState, sectionKey: string): ReviewState {
  return {
    ...state,
    sections: state.sections.map((section) =>
      section.key === sectionKey
        ? { ...section, dishes: section.dishes.map((dish) => ({ ...dish, checked: true })) }
        : section,
    ),
  };
}

/** Leaves a dish out of the import (a heading read as a dish, say); empty sections go too. */
export function removeDish(state: ReviewState, dishKey: string): ReviewState {
  return {
    ...state,
    sections: state.sections
      .map((section) => ({
        ...section,
        dishes: section.dishes.filter((dish) => dish.key !== dishKey),
      }))
      .filter((section) => section.dishes.length > 0),
  };
}

/** The request for the server, which checks every dish again (ONB-006). */
export function reviewRequest(state: ReviewState): MenuReviewRequest {
  return {
    categories: state.sections.map((section) => ({
      name: section.name.trim(),
      items: section.dishes.map((dish) => ({
        name: dish.name.trim(),
        description: dish.description.trim() === '' ? null : dish.description.trim(),
        price: dish.price.trim() === '' ? null : (paiseOf(dish.price) ?? null),
        variants: dish.variants.map((variant) => ({
          name: variant.name.trim(),
          price: paiseOf(variant.price) ?? 0,
        })),
        foodType: dish.foodType === '' ? 'VEG' : dish.foodType,
        spiceLevel: dish.spiceLevel,
        tags: [...dish.tags],
        taxGroupId: section.taxGroupId,
        stationId: section.stationId,
        checked: dish.checked,
      })),
    })),
    addOns: state.addOns.map((addOn) => ({
      group: addOn.group,
      minSelections: 0,
      maxSelections: Math.min(20, addOn.options.length),
      options: addOn.options.map((option) => ({ name: option.name, priceDelta: option.price })),
    })),
  };
}
