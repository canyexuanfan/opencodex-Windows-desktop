import type { IncomingMeta, ProviderAdapter } from "../../adapters/base";
import { createTranslatorBudget, type TranslatorBudget } from "../../lib/translator-budget";

type TestAdapter<T extends ProviderAdapter> = Omit<T, "buildRequest" | "parseStream" | "parseResponse"> & {
  buildRequest(
    parsed: Parameters<T["buildRequest"]>[0],
    incoming?: Partial<IncomingMeta>,
  ): ReturnType<T["buildRequest"]>;
  parseStream(response: Response, budget?: TranslatorBudget): ReturnType<T["parseStream"]>;
  parseResponse?: (
    response: Response,
    budget?: TranslatorBudget,
  ) => ReturnType<NonNullable<T["parseResponse"]>>;
};

/** Inject translator budget for harness adapter calls (mirrors tests/helpers/translator-budget). */
export function withHarnessTranslatorBudget<T extends ProviderAdapter>(adapter: T): TestAdapter<T> {
  const budget = createTranslatorBudget();
  const buildRequest = adapter.buildRequest.bind(adapter);
  const parseStream = adapter.parseStream.bind(adapter);
  const parseResponse = adapter.parseResponse?.bind(adapter);
  return {
    ...adapter,
    buildRequest(parsed: Parameters<T["buildRequest"]>[0], incoming?: Partial<IncomingMeta>) {
      return buildRequest(parsed, {
        ...incoming,
        headers: incoming?.headers ?? new Headers(),
        translatorBudget: incoming?.translatorBudget ?? budget,
      });
    },
    parseStream(response: Response, explicitBudget?: TranslatorBudget) {
      return parseStream(response, explicitBudget ?? budget);
    },
    ...(parseResponse ? {
      parseResponse(response: Response, explicitBudget?: TranslatorBudget) {
        return parseResponse(response, explicitBudget ?? budget);
      },
    } : {}),
  } as unknown as TestAdapter<T>;
}
