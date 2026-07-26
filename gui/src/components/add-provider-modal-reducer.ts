import type { CatalogPreset } from "./provider-catalog/provider-presets";
import type { ProviderPayloadForm } from "../provider-payload";

type Preset = CatalogPreset;
type FormState = ProviderPayloadForm;

export type AddProviderModalState = {
  preset: Preset | null;
  form: FormState | null;
  saving: boolean;
  error: string;
  oauthBusy: boolean;
  oauthMsg: string;
  oauthMsgTone: "ok" | "warn";
  manualCode: string;
  manualCodeBusy: boolean;
  manualCodeMsg: string;
  manualCodeOk: boolean;
  endpointChoice: string;
  oauthTosPending: string | null;
};

export type AddProviderModalAction =
  | { type: "choose-preset"; preset: Preset; form: FormState; endpointChoice: string }
  | { type: "back" }
  | { type: "set-form"; form: FormState }
  | { type: "set-endpoint-choice"; choice: string }
  | { type: "set-saving"; saving: boolean }
  | { type: "set-error"; error: string }
  | { type: "set-oauth-busy"; busy: boolean }
  | { type: "set-oauth-msg"; msg: string; tone?: "ok" | "warn" }
  | { type: "set-oauth-tone"; tone: "ok" | "warn" }
  | { type: "set-manual-code"; code: string }
  | { type: "set-manual-code-busy"; busy: boolean }
  | { type: "set-manual-code-msg"; msg: string; ok?: boolean }
  | { type: "set-oauth-tos-pending"; providerId: string | null }
  | { type: "use-oauth-login"; form: FormState }
  | { type: "use-api-key-instead"; form: FormState };

export function createInitialAddProviderState(
  initialCustom: boolean,
  customLabel: string,
): AddProviderModalState {
  const customPreset: Preset = {
    id: "custom",
    label: customLabel,
    adapter: "openai-chat",
    baseUrl: "",
    auth: "key",
  };
  return {
    preset: initialCustom ? customPreset : null,
    form: initialCustom
      ? { name: "", adapter: "openai-chat", baseUrl: "", authMode: "key", apiKey: "", defaultModel: "", allowPrivateNetwork: false }
      : null,
    saving: false,
    error: "",
    oauthBusy: false,
    oauthMsg: "",
    oauthMsgTone: "ok",
    manualCode: "",
    manualCodeBusy: false,
    manualCodeMsg: "",
    manualCodeOk: true,
    endpointChoice: "custom",
    oauthTosPending: null,
  };
}

export function addProviderModalReducer(
  state: AddProviderModalState,
  action: AddProviderModalAction,
): AddProviderModalState {
  switch (action.type) {
    case "choose-preset":
      return {
        ...state,
        preset: action.preset,
        form: action.form,
        endpointChoice: action.endpointChoice,
        error: "",
        oauthMsg: "",
        oauthMsgTone: "ok",
        manualCode: "",
        manualCodeMsg: "",
        manualCodeOk: true,
      };
    case "back":
      return {
        ...state,
        preset: null,
        form: null,
        endpointChoice: "custom",
        error: "",
        oauthMsg: "",
        oauthMsgTone: "ok",
        manualCode: "",
        manualCodeMsg: "",
        manualCodeOk: true,
      };
    case "set-form":
      return { ...state, form: action.form };
    case "set-endpoint-choice":
      return { ...state, endpointChoice: action.choice };
    case "set-saving":
      return { ...state, saving: action.saving };
    case "set-error":
      return { ...state, error: action.error };
    case "set-oauth-busy":
      return { ...state, oauthBusy: action.busy };
    case "set-oauth-msg":
      return { ...state, oauthMsg: action.msg, oauthMsgTone: action.tone ?? state.oauthMsgTone };
    case "set-oauth-tone":
      return { ...state, oauthMsgTone: action.tone };
    case "set-manual-code":
      return { ...state, manualCode: action.code };
    case "set-manual-code-busy":
      return { ...state, manualCodeBusy: action.busy };
    case "set-manual-code-msg":
      return { ...state, manualCodeMsg: action.msg, manualCodeOk: action.ok ?? state.manualCodeOk };
    case "set-oauth-tos-pending":
      return { ...state, oauthTosPending: action.providerId };
    case "use-oauth-login":
      return { ...state, form: action.form, error: "" };
    case "use-api-key-instead":
      return {
        ...state,
        form: action.form,
        oauthMsg: "",
        oauthMsgTone: "ok",
        manualCode: "",
        manualCodeMsg: "",
      };
    default:
      return state;
  }
}
