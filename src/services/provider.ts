import { config } from '../config';
import { KeyManager, AllKeysCooldownError } from '../lib/key-manager';
import { EndpointManager } from '../lib/endpoint-manager';
import { VirtualRouter, createVirtualRouter, NoAvailableBackendError, AllBackendsFailedError } from '../lib/virtual-router';
import { isQuotaError, isInsufficientBalanceError } from '../lib/retry';
import { providerCooldown, createProviderCooldownError } from '../lib/provider-cooldown';
import { registry, RegisteredProvider } from '../providers/registry';
import { modelRegistry } from '../lib/model-registry';
import { loadProviderState } from '../lib/provider-state';
import { loadAllProviderApiKeys, resolveRuntimeKeys } from '../lib/api-key-store';
import { recordUsage } from '../lib/usage-store';
import { getComboContext, ComboRequestContext } from '../lib/combo-context';
import { touchCombo } from '../lib/combo-store';
import { AsyncLocalStorage } from 'async_hooks';
import { wrapStream } from './stream-usage';
import { NvidiaProvider, createNvidiaKeyManager } from '../providers/nvidia';
import { OpenRouterProvider, createOpenRouterKeyManager } from '../providers/openrouter';
import { StepFunProvider, createStepFunKeyManager } from '../providers/stepfun';
import { GlmProvider, createGlmKeyManager } from '../providers/glm';
import { GoRouterProvider, createGoRouterKeyManager } from '../providers/gorouter';
import { InferXProvider, createInferXKeyManager } from '../providers/inferx';
import { OneHopProvider, createOneHopKeyManager } from '../providers/onehop';
import { OrcaRouterProvider, createOrcaRouterKeyManager } from '../providers/orcarouter';
import { SeekAIProvider, createSeekAIKeyManager } from '../providers/seekai';
import { JustWokerProvider, createJustWokerKeyManager } from '../providers/justwoker';
import { BitdeerProvider, createBitdeerKeyManager } from '../providers/bitdeer';
import { HashNeuronProvider, createHashNeuronKeyManager } from '../providers/hashneuron';
import { HCNSecProvider, createHCNSecKeyManager } from '../providers/hcnsec';
import { TeamoRouterProvider, createTeamoRouterKeyManager } from '../providers/teamorouter';
import { GroqProvider, createGroqKeyManager } from '../providers/groq';
import { KiloProvider, createKiloKeyManager } from '../providers/kilo';
import { ZenProvider, createZenKeyManager } from '../providers/zen';
import { InferenceProvider } from '../providers/inference';
import { LogfareProvider, createLogfareKeyManager } from '../providers/logfare';
import { EmperoProvider, createEmperoKeyManager } from '../providers/empero';
import { AgentRouterProvider, createAgentRouterKeyManager } from '../providers/agentrouter';
import { TokenHarborProvider, createTokenHarborKeyManager } from '../providers/tokenharbor';
import { CodeCraftApiProvider, createCodeCraftApiKeyManager } from '../providers/codecraftapi';
import { ClineProvider, createClineKeyManager } from '../providers/cline';
import { DahlProvider, createDahlKeyManager } from '../providers/dahl';
import { TabiTokenProvider, createTabiTokenKeyManager } from '../providers/tabitoken';
import { BaiProvider, createBaiKeyManager } from '../providers/bai';
import { UnliProvider, createUnliKeyManager } from '../providers/unli';
import { Llm7Provider, createLlm7KeyManager } from '../providers/llm7';
import { DeepBricksProvider, createDeepBricksKeyManager } from '../providers/deepbricks';
import { BazaarLinkProvider, createBazaarLinkKeyManager } from '../providers/bazaarlink';
import { CloudflareProvider } from '../providers/cloudflare';
import { DatabricksProvider, createDatabricksEndpointManager } from '../providers/databricks';
import { FreebuffProvider, createFreebuffKeyManager } from '../providers/freebuff';
import { VyceAIProvider, createVyceAIKeyManager } from '../providers/vyceai';
import { TokenRouterProvider, createTokenRouterKeyManager } from '../providers/tokenrouter';
import { HuggingFaceProvider, createHuggingFaceKeyManager } from '../providers/huggingface';
import { GmiProvider, createGmiKeyManager } from '../providers/gmi';
import { XkiroProvider, createXkiroKeyManager } from '../providers/xkiro';
import { KKTokenProvider, createKKTokenKeyManager } from '../providers/kktoken';
import { FlatKeyProvider, createFlatKeyKeyManager } from '../providers/flatkey';
import { AisurplusProvider, createAisurplusKeyManager } from '../providers/aisurplus';
import { KiosapiProvider, createKiosapiKeyManager } from '../providers/kiosapi';
import { NusapiProvider, createNusapiKeyManager } from '../providers/nusapi';
import { ExperientialLabsProvider, createExperientialLabsKeyManager } from '../providers/experientiallabs';
import { CodepusProvider, createCodepusKeyManager } from '../providers/codepus';
import { KieProvider, createKieKeyManager } from '../providers/kie';
import { TokenForgeProvider, createTokenForgeKeyManager } from '../providers/tokenforge';
import { AtriaProvider, createAtriaKeyManager } from '../providers/atria';
import { HiveProvider, createHiveKeyManager } from '../providers/hive';
import { ApmixProvider, createApmixKeyManager } from '../providers/apmix';
import { InvibuilderProvider, createInvibuilderKeyManager } from '../providers/invibuilder';
import { InceptionProvider, createInceptionKeyManager } from '../providers/inception';
import { JijiProvider, createJijiKeyManager } from '../providers/jiji';


const NVIDIA_CHAT_FIELDS = new Set([
  'model', 'messages', 'temperature', 'max_tokens', 'top_p',
  'frequency_penalty', 'presence_penalty', 'n', 'stop',
  'tools', 'tool_choice', 'tool_calls',
  /* Required so OpenAI-compatible upstreams include the final usage chunk in
   * streaming responses — without it streamed requests are recorded with
   * null tokens and the usage dashboard stops accumulating. */
  'stream_options',
]);

function forwardPayload(body: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of NVIDIA_CHAT_FIELDS) {
    const value = body[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  if (result.max_tokens === undefined) {
    result.max_tokens = 2048;
  }
  return result;
}

const keyManagers: Record<string, KeyManager> = {};
const endpointManagers: Record<string, EndpointManager> = {};
let databricksProviderInstance: DatabricksProvider | null = null;
let inferxProviderInstance: InferXProvider | null = null;
let onehopProviderInstance: OneHopProvider | null = null;
let orcarouterProviderInstance: OrcaRouterProvider | null = null;
let seekaiProviderInstance: SeekAIProvider | null = null;
let justwokerProviderInstance: JustWokerProvider | null = null;
let bitdeerProviderInstance: BitdeerProvider | null = null;
let hashneuronProviderInstance: HashNeuronProvider | null = null;
let hcnsecProviderInstance: HCNSecProvider | null = null;
let teamorouterProviderInstance: TeamoRouterProvider | null = null;
let groqProviderInstance: GroqProvider | null = null;
let kiloProviderInstance: KiloProvider | null = null;
let zenProviderInstance: ZenProvider | null = null;
let inferenceProviderInstance: InferenceProvider | null = null;
let logfareProviderInstance: LogfareProvider | null = null;
let emperoProviderInstance: EmperoProvider | null = null;
let agentrouterProviderInstance: AgentRouterProvider | null = null;
let tokenharborProviderInstance: TokenHarborProvider | null = null;
let codecraftapiProviderInstance: CodeCraftApiProvider | null = null;
let clineProviderInstance: ClineProvider | null = null;
let dahlProviderInstance: DahlProvider | null = null;
let tabitokenProviderInstance: TabiTokenProvider | null = null;
let baiProviderInstance: BaiProvider | null = null;
let unliProviderInstance: UnliProvider | null = null;
let llm7ProviderInstance: Llm7Provider | null = null;
let deepbricksProviderInstance: DeepBricksProvider | null = null;
let bazaarlinkProviderInstance: BazaarLinkProvider | null = null;
let freebuffProviderInstance: FreebuffProvider | null = null;
let vyceaiProviderInstance: VyceAIProvider | null = null;
let tokenrouterProviderInstance: TokenRouterProvider | null = null;
let huggingfaceProviderInstance: HuggingFaceProvider | null = null;
let gmiProviderInstance: GmiProvider | null = null;
let xkiroProviderInstance: XkiroProvider | null = null;
let kktokenProviderInstance: KKTokenProvider | null = null;
let flatkeyProviderInstance: FlatKeyProvider | null = null;
let aisurplusProviderInstance: AisurplusProvider | null = null;
let kiosapiProviderInstance: KiosapiProvider | null = null;
let nusapiProviderInstance: NusapiProvider | null = null;
let experientiallabsProviderInstance: ExperientialLabsProvider | null = null;
let codepusProviderInstance: CodepusProvider | null = null;
let kieProviderInstance: KieProvider | null = null;
let tokenforgeProviderInstance: TokenForgeProvider | null = null;
let atriaProviderInstance: AtriaProvider | null = null;
let hiveProviderInstance: HiveProvider | null = null;
let apmixProviderInstance: ApmixProvider | null = null;
let invibuilderProviderInstance: InvibuilderProvider | null = null;
let inceptionProviderInstance: InceptionProvider | null = null;
let jijiProviderInstance: JijiProvider | null = null;
export const virtualRouter = createVirtualRouter(config.virtualRoutes);

function initNvidiaProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('nvidia', config.nvidiaApiKeys);
  if (keys.length === 0) return;
  const km = createNvidiaKeyManager(keys);
  keyManagers.nvidia = km;
  const provider = new NvidiaProvider(km, config.nvidiaBaseUrl, config.timeout);
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: NVIDIA NIM ===');
  console.log(`=== providerId: nvidia ===`);
  console.log(`=== NVIDIA_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initOpenRouterProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('openrouter', config.openrouterApiKeys);
  if (keys.length === 0) return;
  const km = createOpenRouterKeyManager(keys);
  keyManagers.openrouter = km;
  const provider = new OpenRouterProvider(km, config.openrouterBaseUrl, config.timeout, config.openrouterSiteUrl, config.openrouterSiteName);
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: OpenRouter ===');
  console.log(`=== providerId: openrouter ===`);
  console.log(`=== OPENROUTER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initStepFunProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('stepfun', config.stepfunApiKeys);
  if (keys.length === 0) return;
  const km = createStepFunKeyManager(keys);
  keyManagers.stepfun = km;
  const provider = new StepFunProvider(km, config.stepfunBaseUrl, config.timeout);
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: StepFun ===');
  console.log(`=== providerId: stepfun ===`);
  console.log(`=== STEPFUN_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initGlmProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('glm', config.glmApiKeys);
  if (keys.length === 0) return;
  const km = createGlmKeyManager(keys);
  keyManagers.glm = km;
  const provider = new GlmProvider(km, config.glmBaseUrl, config.timeout);
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: GLM (Zhipu AI) ===');
  console.log(`=== providerId: glm ===`);
  console.log(`=== GLM_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initCloudflareProvider(): void {
  if (!config.cloudflareAccountId || config.cloudflareApiTokens.length === 0) return;
  const km = new KeyManager(config.cloudflareApiTokens, 'Cloudflare');
  keyManagers.cloudflare = km;
  const provider = new CloudflareProvider(km, config.cloudflareAccountId, config.timeout);
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Cloudflare ===');
  console.log(`=== providerId: cloudflare ===`);
  console.log(`=== CLOUDFLARE_ACCOUNT_ID=${config.cloudflareAccountId ? '(set)' : '(NOT SET)'}`);
  console.log(`=== CLOUDFLARE_API_TOKENS count=${config.cloudflareApiTokens.length}`);
  console.log('===========================================');
}



function initGoRouterProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('gorouter', config.gorouterApiKeys);
  if (keys.length === 0) return;
  const km = createGoRouterKeyManager(keys);
  keyManagers.gorouter = km;
  const provider = new GoRouterProvider(km, config.gorouterBaseUrl, config.timeout);
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: GoRouter ===');
  console.log(`=== providerId: gorouter ===`);
  console.log(`=== GOROUTER_BASE_URL=${config.gorouterBaseUrl}`);
  console.log(`=== GOROUTER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initDatabricksProvider(): void {
  if (config.databricksEndpoints.length === 0) return;
  const em = createDatabricksEndpointManager(config.databricksEndpoints);
  endpointManagers.databricks = em;
  const provider = new DatabricksProvider(em, config.timeout, config.databricksModelAliasMap, config.databricksVirtualAliases);
  databricksProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Databricks ===');
  console.log(`=== providerId: databricks ===`);
  console.log(`=== DATABRICKS_ENDPOINT_N count=${config.databricksEndpoints.length}`);
  console.log('===========================================');
}

function initInferXProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('inferx', config.inferxApiKeys);
  if (keys.length === 0) return;
  const km = createInferXKeyManager(keys);
  keyManagers.inferx = km;
  const provider = new InferXProvider(km, config.inferxBaseUrl, config.timeout);
  inferxProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: InferX ===');
  console.log(`=== providerId: inferx ===`);
  console.log(`=== INFERX_BASE_URL=${config.inferxBaseUrl}`);
  console.log(`=== INFERX_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initOneHopProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('onehop', config.onehopApiKeys);
  if (keys.length === 0) return;
  const km = createOneHopKeyManager(keys);
  keyManagers.onehop = km;
  const provider = new OneHopProvider(km, config.onehopBaseUrl, config.timeout);
  onehopProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: OneHop ===');
  console.log(`=== providerId: onehop ===`);
  console.log(`=== ONEHOP_BASE_URL=${config.onehopBaseUrl}`);
  console.log(`=== ONEHOP_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initOrcaRouterProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('orcarouter', config.orcarouterApiKeys);
  if (keys.length === 0) return;
  const km = createOrcaRouterKeyManager(keys);
  keyManagers.orcarouter = km;
  const provider = new OrcaRouterProvider(km, config.orcarouterBaseUrl, config.timeout);
  orcarouterProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: OrcaRouter ===');
  console.log(`=== providerId: orcarouter ===`);
  console.log(`=== ORCAROUTER_BASE_URL=${config.orcarouterBaseUrl}`);
  console.log(`=== ORCAROUTER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initSeekAIProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('seekai', config.seekaiApiKeys);
  if (keys.length === 0) return;
  const km = createSeekAIKeyManager(keys);
  keyManagers.seekai = km;
  const provider = new SeekAIProvider(km, config.seekaiBaseUrl, config.seekaiTimeout);
  seekaiProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: SeekAI ===');
  console.log(`=== providerId: seekai ===`);
  console.log(`=== SEEKAI_BASE_URL=${config.seekaiBaseUrl}`);
  console.log(`=== SEEKAI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initJustWokerProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('justwoker', config.justwokerApiKeys);
  if (keys.length === 0) return;
  const km = createJustWokerKeyManager(keys);
  keyManagers.justwoker = km;
  const provider = new JustWokerProvider(km, config.justwokerBaseUrl, config.justwokerTimeout);
  justwokerProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: JustWoker ===');
  console.log(`=== providerId: justwoker ===`);
  console.log(`=== JUSTWOKER_BASE_URL=${config.justwokerBaseUrl}`);
  console.log(`=== JUSTWOKER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initBitdeerProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('bitdeer', config.bitdeerApiKeys);
  if (keys.length === 0) return;
  const km = createBitdeerKeyManager(keys);
  keyManagers.bitdeer = km;
  const provider = new BitdeerProvider(km, config.bitdeerBaseUrl, config.bitdeerTimeout);
  bitdeerProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Bitdeer ===');
  console.log(`=== providerId: bitdeer ===`);
  console.log(`=== BITDEER_BASE_URL=${config.bitdeerBaseUrl}`);
  console.log(`=== BITDEER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initHashneuronProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('hashneuron', config.hashneuronApiKeys);
  if (keys.length === 0) return;
  const km = createHashNeuronKeyManager(keys);
  keyManagers.hashneuron = km;
  const provider = new HashNeuronProvider(km, config.hashneuronBaseUrl, config.hashneuronTimeout);
  hashneuronProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: HashNeuron ===');
  console.log(`=== providerId: hashneuron ===`);
  console.log(`=== HASHNEURON_BASE_URL=${config.hashneuronBaseUrl}`);
  console.log(`=== HASHNEURON_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initHCNSecProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('hcnsec', config.hcnsecApiKeys);
  if (keys.length === 0) return;
  const km = createHCNSecKeyManager(keys);
  keyManagers.hcnsec = km;
  const provider = new HCNSecProvider(km, config.hcnsecBaseUrl, config.timeout);
  hcnsecProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: HCNSec ===');
  console.log(`=== providerId: hcnsec ===`);
  console.log(`=== HCNSEC_BASE_URL=${config.hcnsecBaseUrl}`);
  console.log(`=== HCNSEC_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initTeamoRouterProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('teamorouter', config.teamorouterApiKeys);
  if (keys.length === 0) return;
  const km = createTeamoRouterKeyManager(keys);
  keyManagers.teamorouter = km;
  const provider = new TeamoRouterProvider(km, config.teamorouterBaseUrl, config.timeout);
  teamorouterProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: TeamoRouter ===');
  console.log(`=== providerId: teamorouter ===`);
  console.log(`=== TEAMOROUTER_BASE_URL=${config.teamorouterBaseUrl}`);
  console.log(`=== TEAMOROUTER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initGroqProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('groq', config.groqApiKeys);
  if (keys.length === 0) return;
  const km = createGroqKeyManager(keys);
  keyManagers.groq = km;
  const provider = new GroqProvider(km, config.groqBaseUrl, config.timeout);
  groqProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Groq ===');
  console.log(`=== providerId: groq ===`);
  console.log(`=== GROQ_BASE_URL=${config.groqBaseUrl}`);
  console.log(`=== GROQ_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initKiloProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('kilo', config.kiloApiKeys);
  if (keys.length === 0) return;
  const km = createKiloKeyManager(keys);
  keyManagers.kilo = km;
  const provider = new KiloProvider(km, config.kiloBaseUrl, config.timeout);
  kiloProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Kilo Gateway ===');
  console.log(`=== providerId: kilo ===`);
  console.log(`=== KILO_BASE_URL=${config.kiloBaseUrl}`);
  console.log(`=== KILO_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initZenProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('zen', config.zenApiKeys);
  if (keys.length === 0) return;
  const km = createZenKeyManager(keys);
  keyManagers.zen = km;
  const provider = new ZenProvider(km, config.zenBaseUrl, config.timeout);
  zenProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: OpenCode Zen ===');
  console.log(`=== providerId: zen ===`);
  console.log(`=== ZEN_BASE_URL=${config.zenBaseUrl}`);
  console.log(`=== ZEN_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initInferenceProvider(): void {
  /* OpenCode Inference API is a SEPARATE channel from OpenCode Zen. Its free
   * tier is invoked WITHOUT an Authorization header, so this provider has NO
   * KeyManager and never touches Zen (or any other) credentials. */
  const provider = new InferenceProvider(config.inferenceBaseUrl, config.timeout);
  inferenceProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: OpenCode Inference ===');
  console.log('=== providerId: opencode-inference ===');
  console.log(`=== INFERENCE_BASE_URL=${config.inferenceBaseUrl}`);
  console.log('=== auth: none (free tier, no Authorization header) ===');
  console.log('===========================================');
}

function initLogfareProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('logfare', config.logfareApiKeys);
  if (keys.length === 0) return;
  const km = createLogfareKeyManager(keys);
  keyManagers.logfare = km;
  const provider = new LogfareProvider(km, config.logfareBaseUrl, config.timeout);
  logfareProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Logfare ===');
  console.log(`=== providerId: logfare ===`);
  console.log(`=== LOGFARE_BASE_URL=${config.logfareBaseUrl}`);
  console.log(`=== LOGFARE_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initEmperoProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('empero', config.emperoApiKeys);
  if (keys.length === 0) return;
  const km = createEmperoKeyManager(keys);
  keyManagers.empero = km;
  const provider = new EmperoProvider(km, config.emperoBaseUrl, config.timeout);
  emperoProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Empero ===');
  console.log(`=== providerId: empero ===`);
  console.log(`=== EMPERO_BASE_URL=${config.emperoBaseUrl}`);
  console.log(`=== EMPERO_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initAgentRouterProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('agentrouter', config.agentrouterApiKeys);
  if (keys.length === 0) return;
  const km = createAgentRouterKeyManager(keys);
  keyManagers.agentrouter = km;
  const provider = new AgentRouterProvider(km, config.agentrouterBaseUrl, config.timeout, config.agentrouterStaticModels, config.agentrouterProxyMode);
  agentrouterProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: AgentRouter ===');
  console.log(`=== providerId: agentrouter ===`);
  console.log(`=== AGENTROUTER_BASE_URL=${config.agentrouterBaseUrl}`);
  console.log(`=== AGENTROUTER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initTokenHarborProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('tokenharbor', config.tokenharborApiKeys);
  if (keys.length === 0) return;
  const km = createTokenHarborKeyManager(keys);
  keyManagers.tokenharbor = km;
  const provider = new TokenHarborProvider(km, config.tokenharborBaseUrl, config.timeout);
  tokenharborProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Token Harbor ===');
  console.log(`=== providerId: tokenharbor ===`);
  console.log(`=== TOKENHARBOR_BASE_URL=${config.tokenharborBaseUrl}`);
  console.log(`=== TOKENHARBOR_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initCodeCraftApiProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('codecraftapi', config.codecraftapiApiKeys);
  if (keys.length === 0) return;
  const km = createCodeCraftApiKeyManager(keys);
  keyManagers.codecraftapi = km;
  const provider = new CodeCraftApiProvider(km, config.codecraftapiBaseUrl, config.codecraftapiTimeout);
  codecraftapiProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: CodeCraft API ===');
  console.log(`=== providerId: codecraftapi ===`);
  console.log(`=== CODECRAFTAPI_BASE_URL=${config.codecraftapiBaseUrl}`);
  console.log(`=== CODECRAFTAPI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initClineProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('cline', config.clineApiKeys);
  if (keys.length === 0) return;
  const km = createClineKeyManager(keys);
  keyManagers.cline = km;
  const provider = new ClineProvider(km, config.clineBaseUrl, config.timeout);
  clineProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Cline API ===');
  console.log(`=== providerId: cline ===`);
  console.log(`=== CLINE_BASE_URL=${config.clineBaseUrl}`);
  console.log(`=== CLINE_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initDahlProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('dahl', config.dahlApiKeys);
  if (keys.length === 0) return;
  const km = createDahlKeyManager(keys);
  keyManagers.dahl = km;
  const provider = new DahlProvider(km, config.dahlBaseUrl, config.timeout);
  dahlProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Dahl Inference ===');
  console.log(`=== providerId: dahl ===`);
  console.log(`=== DAHL_BASE_URL=${config.dahlBaseUrl}`);
  console.log(`=== DAHL_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initTabiTokenProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('tabitoken', config.tabitokenApiKeys);
  if (keys.length === 0) return;
  const km = createTabiTokenKeyManager(keys);
  keyManagers.tabitoken = km;
  const provider = new TabiTokenProvider(km, config.tabitokenBaseUrl, config.timeout);
  tabitokenProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: TabiToken ===');
  console.log(`=== providerId: tabitoken ===`);
  console.log(`=== TABITOKEN_BASE_URL=${config.tabitokenBaseUrl}`);
  console.log(`=== TABITOKEN_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initBaiProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('bai', config.baiApiKeys);
  if (keys.length === 0) return;
  const km = createBaiKeyManager(keys);
  keyManagers.bai = km;
  const provider = new BaiProvider(km, config.baiBaseUrl, config.timeout);
  baiProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: BAI ===');
  console.log(`=== providerId: bai ===`);
  console.log(`=== BAI_BASE_URL=${config.baiBaseUrl}`);
  console.log(`=== BAI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initUnliProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('unli', config.unliApiKeys);
  if (keys.length === 0) return;
  const km = createUnliKeyManager(keys);
  keyManagers.unli = km;
  const provider = new UnliProvider(km, config.unliBaseUrl, config.timeout);
  unliProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: UNLI ===');
  console.log(`=== providerId: unli ===`);
  console.log(`=== UNLI_BASE_URL=${config.unliBaseUrl}`);
  console.log(`=== UNLI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initBazaarLinkProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('bazaarlink', config.bazaarlinkApiKeys);
  if (keys.length === 0) return;
  const km = createBazaarLinkKeyManager(keys);
  keyManagers.bazaarlink = km;
  const provider = new BazaarLinkProvider(km, config.bazaarlinkBaseUrl, config.timeout);
  bazaarlinkProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: BazaarLink ===');
  console.log(`=== providerId: bazaarlink ===`);
  console.log(`=== BAZAARLINK_BASE_URL=${config.bazaarlinkBaseUrl}`);
  console.log(`=== BAZAARLINK_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initFreebuffProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('freebuff', config.freebuffApiKeys);
  if (keys.length === 0) return;
  const km = createFreebuffKeyManager(keys);
  keyManagers.freebuff = km;
  const provider = new FreebuffProvider(km, config.freebuffBaseUrl, config.timeout);
  freebuffProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Freebuff (Codebuff Free) ===');
  console.log(`=== providerId: freebuff ===`);
  console.log(`=== FREEBUFF_BASE_URL=${config.freebuffBaseUrl}`);
  console.log(`=== FREEBUFF_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initLlm7Provider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('llm7', config.llm7ApiKeys);
  if (keys.length === 0) return;
  const km = createLlm7KeyManager(keys);
  keyManagers.llm7 = km;
  const provider = new Llm7Provider(km, config.llm7BaseUrl, config.timeout);
  llm7ProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: LLM7 ===');
  console.log(`=== providerId: llm7 ===`);
  console.log(`=== LLM7_BASE_URL=${config.llm7BaseUrl}`);
  console.log(`=== LLM7_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initVyceAIProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('vyceai', config.vyceaiApiKeys);
  if (keys.length === 0) return;
  const km = createVyceAIKeyManager(keys);
  keyManagers.vyceai = km;
  const provider = new VyceAIProvider(km, config.vyceaiBaseUrl, config.timeout);
  vyceaiProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: VyceAI ===');
  console.log(`=== providerId: vyceai ===`);
  console.log(`=== VYCEAI_BASE_URL=${config.vyceaiBaseUrl}`);
  console.log(`=== VYCEAI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initTokenRouterProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('tokenrouter', config.tokenrouterApiKeys);
  if (keys.length === 0) return;
  const km = createTokenRouterKeyManager(keys);
  keyManagers.tokenrouter = km;
  const provider = new TokenRouterProvider(km, config.tokenrouterBaseUrl, config.timeout);
  tokenrouterProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: TokenRouter ===');
  console.log(`=== providerId: tokenrouter ===`);
  console.log(`=== TOKENROUTER_BASE_URL=${config.tokenrouterBaseUrl}`);
  console.log(`=== TOKENROUTER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initDeepBricksProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('deepbricks', config.deepbricksApiKeys);
  if (keys.length === 0) return;
  const km = createDeepBricksKeyManager(keys);
  keyManagers.deepbricks = km;
  const provider = new DeepBricksProvider(km, config.deepbricksBaseUrl, config.timeout);
  deepbricksProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: DeepBricks ===');
  console.log(`=== providerId: deepbricks ===`);
  console.log(`=== DEEPBRICKS_BASE_URL=${config.deepbricksBaseUrl}`);
  console.log(`=== DEEPBRICKS_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initHuggingFaceProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('huggingface', config.huggingfaceApiKeys);
  if (keys.length === 0) return;
  const km = createHuggingFaceKeyManager(keys);
  keyManagers.huggingface = km;
  const provider = new HuggingFaceProvider(km, config.huggingfaceBaseUrl, config.timeout);
  huggingfaceProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Hugging Face ===');
  console.log(`=== providerId: huggingface ===`);
  console.log(`=== HUGGINGFACE_BASE_URL=${config.huggingfaceBaseUrl}`);
  console.log(`=== HUGGINGFACE_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initGmiProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('gmi', config.gmiApiKeys);
  if (keys.length === 0) return;
  const km = createGmiKeyManager(keys);
  keyManagers.gmi = km;
  const provider = new GmiProvider(km, config.gmiBaseUrl, config.timeout);
  gmiProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: GMI Cloud ===');
  console.log(`=== providerId: gmi ===`);
  console.log(`=== GMI_BASE_URL=${config.gmiBaseUrl}`);
  console.log(`=== GMI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initXkiroProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('xkiro', config.xkiroApiKeys);
  if (keys.length === 0) return;
  const km = createXkiroKeyManager(keys);
  keyManagers.xkiro = km;
  const provider = new XkiroProvider(km, config.xkiroBaseUrl, config.timeout);
  xkiroProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Xkiro ===');
  console.log(`=== providerId: xkiro ===`);
  console.log(`=== XKIRO_BASE_URL=${config.xkiroBaseUrl}`);
  console.log(`=== XKIRO_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initKKTokenProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('kktoken', config.kktokenApiKeys);
  if (keys.length === 0) return;
  const km = createKKTokenKeyManager(keys);
  keyManagers.kktoken = km;
  const provider = new KKTokenProvider(km, config.kktokenBaseUrl, config.timeout);
  kktokenProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: KKToken ===');
  console.log(`=== providerId: kktoken ===`);
  console.log(`=== KKTOKEN_BASE_URL=${config.kktokenBaseUrl}`);
  console.log(`=== KKTOKEN_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initFlatKeyProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('flatkey', config.flatkeyApiKeys);
  if (keys.length === 0) return;
  const km = createFlatKeyKeyManager(keys);
  keyManagers.flatkey = km;
  const provider = new FlatKeyProvider(km, config.flatkeyBaseUrl, config.flatkeyTimeout);
  flatkeyProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: FlatKey ===');
  console.log(`=== providerId: flatkey ===`);
  console.log(`=== FLATKEY_BASE_URL=${config.flatkeyBaseUrl}`);
  console.log(`=== FLATKEY_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initAisurplusProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('aisurplus', config.aisurplusApiKeys);
  if (keys.length === 0) return;
  const km = createAisurplusKeyManager(keys);
  keyManagers.aisurplus = km;
  const provider = new AisurplusProvider(km, config.aisurplusBaseUrl, config.aisurplusTimeout);
  aisurplusProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Aisurplus ===');
  console.log(`=== providerId: aisurplus ===`);
  console.log(`=== AISURPLUS_BASE_URL=${config.aisurplusBaseUrl}`);
  console.log(`=== AISURPLUS_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initKiosapiProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('kiosapi', config.kiosapiApiKeys);
  if (keys.length === 0) return;
  const km = createKiosapiKeyManager(keys);
  keyManagers.kiosapi = km;
  const provider = new KiosapiProvider(km, config.kiosapiBaseUrl, config.kiosapiTimeout);
  kiosapiProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: KiosAPI ===');
  console.log(`=== providerId: kiosapi ===`);
  console.log(`=== KIOSAPI_BASE_URL=${config.kiosapiBaseUrl}`);
  console.log(`=== KIOSAPI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initNusapiProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('nusapi', config.nusapiApiKeys);
  if (keys.length === 0) return;
  const km = createNusapiKeyManager(keys);
  keyManagers.nusapi = km;
  const provider = new NusapiProvider(km, config.nusapiBaseUrl, config.nusapiTimeout);
  nusapiProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: NusAPI ===');
  console.log(`=== providerId: nusapi ===`);
  console.log(`=== NUSAPI_BASE_URL=${config.nusapiBaseUrl}`);
  console.log(`=== NUSAPI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initExperientialLabsProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('experientiallabs', config.experientiallabsApiKeys);
  if (keys.length === 0) return;
  const km = createExperientialLabsKeyManager(keys);
  keyManagers.experientiallabs = km;
  const provider = new ExperientialLabsProvider(km, config.experientiallabsBaseUrl, config.experientiallabsTimeout);
  experientiallabsProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: ExperientialLabs ===');
  console.log(`=== providerId: experientiallabs ===`);
  console.log(`=== EXPERIENTIALLABS_BASE_URL=${config.experientiallabsBaseUrl}`);
  console.log(`=== EXPERIENTIALLABS_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initCodepusProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('codepus', config.codepusApiKeys);
  if (keys.length === 0) return;
  const km = createCodepusKeyManager(keys);
  keyManagers.codepus = km;
  const provider = new CodepusProvider(km, config.codepusBaseUrl, config.codepusTimeout);
  codepusProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Codepus ===');
  console.log(`=== providerId: codepus ===`);
  console.log(`=== CODEPUS_BASE_URL=${config.codepusBaseUrl}`);
  console.log(`=== CODEPUS_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initKieProvider(): void {
  // UI-managed store is the single runtime credential source once migrated
  // (env keys retired); env KIE_API_KEY_1..N only seeds fresh installs.
  const keys = resolveRuntimeKeys('kie.ai', config.kieApiKeys);
  if (keys.length === 0) return;
  const km = createKieKeyManager(keys);
  keyManagers['kie.ai'] = km;
  const provider = new KieProvider(km, config.kieBaseUrl, config.kieTimeout);
  kieProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Kie.ai (multi-route: gemini/claude/codex) ===');
  console.log('=== providerId: kie.ai ===');
  console.log(`=== KIE_BASE_URL=${config.kieBaseUrl}`);
  console.log(`=== KIE_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initTokenForgeProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('tokenforge', config.tokenforgeApiKeys);
  if (keys.length === 0) return;
  const km = createTokenForgeKeyManager(keys);
  keyManagers.tokenforge = km;
  const provider = new TokenForgeProvider(km, config.tokenforgeBaseUrl, config.tokenforgeTimeout);
  tokenforgeProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: TokenForge ===');
  console.log(`=== providerId: tokenforge ===`);
  console.log(`=== TOKENFORGE_BASE_URL=${config.tokenforgeBaseUrl}`);
  console.log(`=== TOKENFORGE_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initAtriaProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('atria', config.atriaApiKeys);
  if (keys.length === 0) return;
  const km = createAtriaKeyManager(keys);
  keyManagers.atria = km;
  const provider = new AtriaProvider(km, config.atriaBaseUrl, config.atriaTimeout);
  atriaProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Atria ===');
  console.log(`=== providerId: atria ===`);
  console.log(`=== ATRIA_BASE_URL=${config.atriaBaseUrl}`);
  console.log(`=== ATRIA_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initHiveProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('hive', config.hiveApiKeys);
  if (keys.length === 0) return;
  const km = createHiveKeyManager(keys);
  keyManagers.hive = km;
  const provider = new HiveProvider(km, config.hiveBaseUrl, config.hiveTimeout);
  hiveProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Hive (thehive.ai) ===');
  console.log(`=== providerId: hive ===`);
  console.log(`=== HIVE_BASE_URL=${config.hiveBaseUrl}`);
  console.log(`=== HIVE_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initApmixProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('apmix', config.apmixApiKeys);
  if (keys.length === 0) return;
  const km = createApmixKeyManager(keys);
  keyManagers.apmix = km;
  const provider = new ApmixProvider(km, config.apmixBaseUrl, config.apmixTimeout);
  apmixProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Apmix ===');
  console.log(`=== providerId: apmix ===`);
  console.log(`=== APMIX_BASE_URL=${config.apmixBaseUrl}`);
  console.log(`=== APMIX_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initInvibuilderProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('invibuilder', config.invibuilderApiKeys);
  if (keys.length === 0) return;
  const km = createInvibuilderKeyManager(keys);
  keyManagers.invibuilder = km;
  const provider = new InvibuilderProvider(km, config.invibuilderBaseUrl, config.invibuilderTimeout);
  invibuilderProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Invibuilder ===');
  console.log(`=== providerId: invibuilder ===`);
  console.log(`=== INVIBUILDER_BASE_URL=${config.invibuilderBaseUrl}`);
  console.log(`=== INVIBUILDER_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initInceptionProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('inception', config.inceptionApiKeys);
  if (keys.length === 0) return;
  const km = createInceptionKeyManager(keys);
  keyManagers.inception = km;
  const provider = new InceptionProvider(km, config.inceptionBaseUrl, config.inceptionTimeout);
  inceptionProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Inception ===');
  console.log(`=== providerId: inception ===`);
  console.log(`=== INCEPTION_BASE_URL=${config.inceptionBaseUrl}`);
  console.log(`=== INCEPTION_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

function initJijiProvider(): void {
  // UI-managed store is the single runtime credential source (env keys retired).
  const keys = resolveRuntimeKeys('jiji', config.jijiApiKeys);
  if (keys.length === 0) return;
  const km = createJijiKeyManager(keys);
  keyManagers.jiji = km;
  const provider = new JijiProvider(km, config.jijiBaseUrl, config.jijiTimeout);
  jijiProviderInstance = provider;
  registry.register(
    provider.getProviderInfo(),
    provider,
  );
  console.log('===========================================');
  console.log('=== Provider: Jiji ===');
  console.log(`=== providerId: jiji ===`);
  console.log(`=== JIJI_BASE_URL=${config.jijiBaseUrl}`);
  console.log(`=== JIJI_UI_KEYS count=${keys.length}`);
  console.log('===========================================');
}

export async function initProvider(): Promise<void> {
  console.log('[TRACE] Enter services/provider.initProvider');

  const persistedDisabled = loadProviderState();
  const mergedDisabled = new Set([...config.disabledProviders, ...persistedDisabled]);
  registry.setDisabled(Array.from(mergedDisabled));
  if (persistedDisabled.length > 0) {
    console.log(`[TRACE] Merged persisted disabled providers: ${persistedDisabled.join(', ')}`);
  }

  for (const [alias, target] of config.modelAliases) {
    modelRegistry.registerAlias(alias, target);
  }


  initCloudflareProvider();
  initStepFunProvider();
  initGlmProvider();
  initOpenRouterProvider();
  initNvidiaProvider();
  initDatabricksProvider();
  // GoRouter is registered last so its API keys sit at the bottom of the key
  // set (multi-key round-robin still applies within the provider). Routing
  // order is decided by priority in the ModelRegistry, not registration order.
  initGoRouterProvider();
  initInferXProvider();
  initOneHopProvider();
  initOrcaRouterProvider();
  initSeekAIProvider();
  initJustWokerProvider();
  initBitdeerProvider();
  initHashneuronProvider();
  initHCNSecProvider();
  initTeamoRouterProvider();
  initGroqProvider();
  initKiloProvider();
  initZenProvider();
  initInferenceProvider();
  initLogfareProvider();
  initEmperoProvider();
  initAgentRouterProvider();
  initTokenHarborProvider();
  initCodeCraftApiProvider();
  initClineProvider();
  initDahlProvider();
  initTabiTokenProvider();
  initBaiProvider();
  initUnliProvider();
  initLlm7Provider();
  initBazaarLinkProvider();
  initFreebuffProvider();
  initDeepBricksProvider();
  initVyceAIProvider();
  initTokenRouterProvider();
  initHuggingFaceProvider();
  initGmiProvider();
  initXkiroProvider();
  initKKTokenProvider();
  initFlatKeyProvider();
  initAisurplusProvider();
  initKiosapiProvider();
  initNusapiProvider();
  initExperientialLabsProvider();
  initCodepusProvider();
  initKieProvider();
  initTokenForgeProvider();
  initAtriaProvider();
  initHiveProvider();
  initApmixProvider();
  initInvibuilderProvider();
  initInceptionProvider();
  initJijiProvider();

  /* Apply UI-managed (persisted) API keys on top of the env-seeded keys so
   * keys added via the Admin dashboard survive restarts and are usable by the
   * runtime rotation immediately. */
  applyAllPersistedApiKeys();

  if (registry.getAllProviders().length === 0) {
    throw new Error(
      'No API keys configured. Set at least one of: NVIDIA_API_KEYS, OPENROUTER_API_KEYS, ' +
      'STEPFUN_API_KEYS, GLM_API_KEYS, GOROUTER_API_KEYS, INFERX_API_KEYS, ONEHOP_API_KEYS, SEEKAI_API_KEY_1..5, HCNSEC_API_KEY, ZEN_API_KEYS, LOGFARE_API_KEYS, AGENTROUTER_API_KEYS, TOKENHARBOR_API_KEYS, CLINE_API_KEYS, TABITOKEN_API_KEYS, TEAMOROUTER_API_KEY, LLM7_API_KEYS, CLOUDFLARE_API_TOKENS, GMI_API_KEYS, KKTOKEN_API_KEYS, Xkiro_API_KEYS, or DATABRICKS_ENDPOINT_N.',
    );
  }

  await modelRegistry.loadFromProviders();

  modelRegistry.printRegistry();

  const allIds = registry.getAllProviders().map(p => p.identity.providerId);
  const enabledIds = registry.getEnabledProviderIds();
  const disabledIds = registry.getDisabledProviders();
  const enabled = allIds.filter(id => enabledIds.includes(id));
  const disabled = allIds.filter(id => disabledIds.includes(id));

  console.log('');
  console.log('=== Provider Registration Summary ===');
  console.log(`Enabled providers:  ${enabled.length > 0 ? enabled.join(', ') : '(none)'}`);
  console.log(`Disabled providers: ${disabled.length > 0 ? disabled.join(', ') : '(none)'}`);
  for (const p of registry.getAllConfiguredProviders()) {
    console.log(`  [ACTIVE] ${p.identity.providerId} (${p.identity.providerName})`);
  }
  console.log('');
}

export function getAllKeyManagers(): Record<string, KeyManager> {
  return { ...keyManagers };
}

/* --------------------- UI-managed API key runtime sync ---------------------
 * Keys added via the Admin dashboard are persisted in
 * config/provider-api-keys.json and merged into the provider's KeyManager so
 * they participate in the EXISTING round-robin rotation. Env-seeded keys stay
 * untouched and always remain usable (ENV + UI-managed keys coexist).
 *
 * Desired runtime state for a provider = env keys + persisted keys whose
 * status is 'active'. Disabled/deleted persisted keys are removed from the
 * rotation but kept in storage (disabled) / dropped (deleted). In-flight
 * requests that already resolved a key are never interrupted — changes apply
 * to new requests only. */

function keyManagerHasRawKey(km: KeyManager, rawKey: string): boolean {
  for (let i = 0; i < km.keyCount; i++) {
    if (km.getKey(i).key === rawKey) return true;
  }
  return false;
}

/** Syncs one provider's KeyManager with the persisted API-key store.
 *  Returns false when the provider has no KeyManager (e.g. Databricks, which
 *  rotates endpoint+key pairs instead). */
export function syncProviderApiKeys(providerId: string): boolean {
  const km = keyManagers[providerId];
  if (!km) return false;
  const records = loadAllProviderApiKeys()[providerId] || [];

  // Remove UI-managed keys whose record was DELETED (no record at all).
  // Only managed keys are ever removed — env-seeded keys (no record by
  // design) and startup-seeded UI keys stay stored; a disabled record keeps
  // its key stored so re-enabling works without re-adding the credential.
  for (let i = km.keyCount - 1; i >= 0; i--) {
    const raw = km.getKey(i).key;
    if (!km.isManagedKey(raw)) continue;
    const rec = records.find(r => r.key === raw);
    if (!rec) {
      km.removeKeyByValue(raw);
    }
  }

  // Mirror the store's active/disabled status onto the runtime rotation for
  // EVERY key that has a record. Startup-seeded UI keys are not "managed"
  // (managedKeys only tracks addKey() calls), so the old managed-only loop
  // never touched them — an admin disable had zero runtime effect until the
  // next restart. Keys with no record are env-seeded: leave them alone.
  for (let i = 0; i < km.keyCount; i++) {
    const raw = km.getKey(i).key;
    const rec = records.find(r => r.key === raw);
    if (!rec) continue;
    if (rec.status === 'active') {
      km.enableKeyByValue(raw);
    } else {
      km.disableKeyByValue(raw);
    }
  }

  // Add active persisted keys missing from the runtime rotation.
  let added = 0;
  for (const rec of records) {
    if (rec.status !== 'active') continue;
    if (!keyManagerHasRawKey(km, rec.key)) {
      km.addKey(rec.key);
      added++;
    }
  }
  if (added > 0 || records.length > 0) {
    console.log(`[ApiKeySync] Provider "${providerId}" runtime keys synced: total=${km.keyCount}, managed=${records.length}`);
  }
  return true;
}

function applyAllPersistedApiKeys(): void {
  const all = loadAllProviderApiKeys();
  for (const providerId of Object.keys(all)) {
    syncProviderApiKeys(providerId);
  }
}

export function getAllEndpointManagers(): Record<string, EndpointManager> {
  return { ...endpointManagers };
}

export function getDatabricksProvider(): DatabricksProvider | null {
  return databricksProviderInstance;
}

export async function getInferXHealth(): Promise<any> {
  if (!inferxProviderInstance) return null;
  return inferxProviderInstance.healthCheck();
}

export async function getOneHopHealth(): Promise<any> {
  if (!onehopProviderInstance) return null;
  return onehopProviderInstance.healthCheck();
}

export async function getOrcaRouterHealth(): Promise<any> {
  if (!orcarouterProviderInstance) return null;
  return orcarouterProviderInstance.healthCheck();
}

export async function getSeekAIHealth(): Promise<any> {
  if (!seekaiProviderInstance) return null;
  return seekaiProviderInstance.healthCheck();
}

export async function getHCNSecHealth(): Promise<any> {
  if (!hcnsecProviderInstance) return null;
  return hcnsecProviderInstance.healthCheck();
}

export async function getTeamoRouterHealth(): Promise<any> {
  if (!teamorouterProviderInstance) return null;
  return teamorouterProviderInstance.healthCheck();
}

export async function getGroqHealth(): Promise<any> {
  if (!groqProviderInstance) return null;
  return groqProviderInstance.healthCheck();
}

export async function getKiloHealth(): Promise<any> {
  if (!kiloProviderInstance) return null;
  return kiloProviderInstance.healthCheck();
}

export async function getZenHealth(): Promise<any> {
  if (!zenProviderInstance) return null;
  return zenProviderInstance.healthCheck();
}

export async function getLogfareHealth(): Promise<any> {
  if (!logfareProviderInstance) return null;
  return logfareProviderInstance.healthCheck();
}

export async function getEmperoHealth(): Promise<any> {
  if (!emperoProviderInstance) return null;
  return emperoProviderInstance.healthCheck();
}

export async function getAgentRouterHealth(): Promise<any> {
  if (!agentrouterProviderInstance) return null;
  return agentrouterProviderInstance.healthCheck();
}

export async function getTokenHarborHealth(): Promise<any> {
  if (!tokenharborProviderInstance) return null;
  return tokenharborProviderInstance.healthCheck();
}

export async function getCodeCraftApiHealth(): Promise<any> {
  if (!codecraftapiProviderInstance) return null;
  return codecraftapiProviderInstance.healthCheck();
}

export async function getClineHealth(): Promise<any> {
  if (!clineProviderInstance) return null;
  return clineProviderInstance.healthCheck();
}

export async function getDahlHealth(): Promise<any> {
  if (!dahlProviderInstance) return null;
  return dahlProviderInstance.healthCheck();
}

export async function getTabiTokenHealth(): Promise<any> {
  if (!tabitokenProviderInstance) return null;
  return tabitokenProviderInstance.healthCheck();
}

export async function getBaiHealth(): Promise<any> {
  if (!baiProviderInstance) return null;
  return baiProviderInstance.healthCheck();
}

export async function getHashNeuronHealth(): Promise<any> {
  if (!hashneuronProviderInstance) return null;
  return hashneuronProviderInstance.healthCheck();
}

export async function getUnliHealth(): Promise<any> {
  if (!unliProviderInstance) return null;
  return unliProviderInstance.healthCheck();
}

export async function getLlm7Health(): Promise<any> {
  if (!llm7ProviderInstance) return null;
  return llm7ProviderInstance.healthCheck();
}

export async function getBazaarLinkHealth(): Promise<any> {
  if (!bazaarlinkProviderInstance) return null;
  return bazaarlinkProviderInstance.healthCheck();
}

export async function getFreebuffHealth(): Promise<any> {
  if (!freebuffProviderInstance) return null;
  return freebuffProviderInstance.healthCheck();
}

export async function getVyceAIHealth(): Promise<any> {
  if (!vyceaiProviderInstance) return null;
  return vyceaiProviderInstance.healthCheck();
}

export async function getTokenRouterHealth(): Promise<any> {
  if (!tokenrouterProviderInstance) return null;
  return tokenrouterProviderInstance.healthCheck();
}

export async function getDeepBricksHealth(): Promise<any> {
  if (!deepbricksProviderInstance) return null;
  return deepbricksProviderInstance.healthCheck();
}

export async function getHuggingFaceHealth(): Promise<any> {
  if (!huggingfaceProviderInstance) return null;
  return huggingfaceProviderInstance.healthCheck();
}

export async function getGmiHealth(): Promise<any> {
  if (!gmiProviderInstance) return null;
  return gmiProviderInstance.healthCheck();
}

export async function getXkiroHealth(): Promise<any> {
  if (!xkiroProviderInstance) return null;
  return xkiroProviderInstance.healthCheck();
}

export async function getKKTokenHealth(): Promise<any> {
  if (!kktokenProviderInstance) return null;
  return kktokenProviderInstance.healthCheck();
}

export async function getFlatKeyHealth(): Promise<any> {
  if (!flatkeyProviderInstance) return null;
  return flatkeyProviderInstance.healthCheck();
}

export async function getAisurplusHealth(): Promise<any> {
  if (!aisurplusProviderInstance) return null;
  return aisurplusProviderInstance.healthCheck();
}

export async function getKiosapiHealth(): Promise<any> {
  if (!kiosapiProviderInstance) return null;
  return kiosapiProviderInstance.healthCheck();
}

export async function getNusapiHealth(): Promise<any> {
  if (!nusapiProviderInstance) return null;
  return nusapiProviderInstance.healthCheck();
}

export async function getExperientialLabsHealth(): Promise<any> {
  if (!experientiallabsProviderInstance) return null;
  return experientiallabsProviderInstance.healthCheck();
}

export async function getCodepusHealth(): Promise<any> {
  if (!codepusProviderInstance) return null;
  return codepusProviderInstance.healthCheck();
}

export async function getKieHealth(): Promise<any> {
  if (!kieProviderInstance) return null;
  return kieProviderInstance.healthCheck();
}

export async function getTokenForgeHealth(): Promise<any> {
  if (!tokenforgeProviderInstance) return null;
  return tokenforgeProviderInstance.healthCheck();
}

export async function getAtriaHealth(): Promise<any> {
  if (!atriaProviderInstance) return null;
  return atriaProviderInstance.healthCheck();
}

export async function getHiveHealth(): Promise<any> {
  if (!hiveProviderInstance) return null;
  return hiveProviderInstance.healthCheck();
}

export async function getApmixHealth(): Promise<any> {
  if (!apmixProviderInstance) return null;
  return apmixProviderInstance.healthCheck();
}

export async function getInvibuilderHealth(): Promise<any> {
  if (!invibuilderProviderInstance) return null;
  return invibuilderProviderInstance.healthCheck();
}

export async function getInceptionHealth(): Promise<any> {
  if (!inceptionProviderInstance) return null;
  return inceptionProviderInstance.healthCheck();
}

export async function getJijiHealth(): Promise<any> {
  if (!jijiProviderInstance) return null;
  return jijiProviderInstance.healthCheck();
}

export async function getInferenceHealth(): Promise<any> {
  if (!inferenceProviderInstance) return null;
  return inferenceProviderInstance.healthCheck();
}

export function getProviderName(): string {
  const configured = registry.getAllConfiguredProviders();
  if (configured.length === 0) return 'unknown';
  return configured[0].identity.providerId;
}

export function getProviderIdForModel(model: string): string | null {
  const provider = registry.getProviderForModel(model);
  return provider ? provider.identity.providerId : null;
}

export function getPrimaryProviderId(): string {
  const configured = registry.getAllConfiguredProviders();
  return configured.length > 0 ? configured[0].identity.providerId : 'unknown';
}

function resolveProvidersForModel(model: string): Array<{ rp: RegisteredProvider; modelName: string; backendModel: string; priority: number }> {  const firstSlash = model.indexOf('/');
  if (firstSlash > 0) {
    const prefix = model.substring(0, firstSlash);
    const rp = registry.getProviderById(prefix);
    if (rp) {
      const strippedName = model.substring(firstSlash + 1);
      // Only treat "<prefix>/<model>" as an explicit provider selector when the
      // provider actually has that exact model. Otherwise the prefix is really an
      // org/vendor namespace (e.g. "nvidia/llama-...-instruct" or
      // "deepseek-ai/deepseek-v4-flash") and we fall through to the priority-based
      // ModelRegistry lookup instead of hard-failing.
      if (modelRegistry.hasModel(strippedName, prefix)) {
        const backendModel = modelRegistry.getBackendModel(strippedName, prefix) ?? strippedName;
        const priority = modelRegistry.getPriority(strippedName, prefix) ?? 0;
        logLookup(model, `FOUND via explicit provider prefix: ${prefix}`);
        return [{ rp, modelName: strippedName, backendModel, priority }];
      }
    }
  }

  const registrations = modelRegistry.getProvidersForModel(model);
  if (registrations.length === 0) {
    logLookup(model, 'NOT FOUND');
    return [];
  }

  const result: Array<{ rp: RegisteredProvider; modelName: string; backendModel: string; priority: number }> = [];
  for (const reg of registrations) {
    const rp = registry.getProviderById(reg.providerId);
    if (rp) {
      const backendModel = reg.backendModel ?? reg.model;
      result.push({ rp, modelName: reg.model, backendModel, priority: reg.priority });
    }
  }

  // ── COMBO provider lock (overrides normal priority/lock resolution) ────
  // An active combo pins the request to ONE provider. When one is present we
  // keep ONLY the combo provider's registration — normal priority ordering,
  // provider-locked routing and the Claude-family fallback all stay intact
  // for non-combo requests. If the combo provider has no registration for
  // this model we fall through unchanged: applyComboProviderLock surfaces a
  // client-safe error instead of ever routing to another provider.
  const combo = getComboContext();
  if (combo) {
    const comboOnly = result.filter(r => r.rp.identity.providerId === combo.providerId);
    if (comboOnly.length > 0) {
      const ignored = result
        .filter(r => r.rp.identity.providerId !== combo.providerId)
        .map(r => r.rp.identity.providerId)
        .join(', ');
      logLookup(model, `COMBO-LOCKED to provider "${combo.providerId}" (ignored other providers: ${ignored || 'none'})`);
      logResolvedProviders(model, comboOnly);
      return comboOnly;
    }
  }

  // ── Strict provider routing ───────────────────────────────────────────
  // ModelRegistry priority selects one provider. API-key rotation and retry
  // remain inside that provider; another registry candidate is never an
  // implicit failover. Explicit Virtual Routes and Combo locks are handled
  // separately above.
  if (result.length > 1) {
    const locked = result[0];
    const dropped = result.slice(1).map(r => r.rp.identity.providerId).join(', ');
    logLookup(model, `STRICTLY LOCKED to provider "${locked.rp.identity.providerId}" (ignored implicit fallback providers: ${dropped})`);
    logResolvedProviders(model, [locked]);
    return [locked];
  }

  logLookup(model, `FOUND (${result.length} provider(s))`);
  logResolvedProviders(model, result);
  return result;
}

// --- Lazy model (re)discovery ---------------------------------------------
// The model catalog is loaded once at startup. If that one-shot load failed or
// returned an empty list for a dynamic provider (transient network error, a key
// briefly in cooldown, etc.), a model that the provider CAN actually serve would
// be missing from the registry and requests would wrongly 404 with
// "No configured provider supports model". To make routing self-healing, when a
// requested model cannot be resolved we trigger a throttled catalog refresh and
// retry once. Concurrent callers share a single in-flight refresh.
const REDISCOVERY_MIN_INTERVAL_MS = 180_000;
/* Max time a REQUEST waits for on-demand catalog refresh. Discovery runs in
   parallel now, but a single hung upstream must not stall an unknown-model
   400 (blocked-record) path — after the deadline the request proceeds with
   whatever the registry currently knows. The refresh itself keeps running in
   the background so later requests benefit from it. */
const REDISCOVERY_WAIT_MS = Number(process.env.REDISCOVERY_WAIT_MS || 3_000);
let lastRediscovery = 0;
let inFlightRediscovery: Promise<void> | null = null;

async function refreshModelCatalog(reason: string): Promise<void> {
  if (inFlightRediscovery) return inFlightRediscovery;
  const now = Date.now();
  if (now - lastRediscovery < REDISCOVERY_MIN_INTERVAL_MS) return;
  lastRediscovery = now;
  console.log(`[REDISCOVERY] Refreshing model catalog from providers (reason: ${reason})`);
  inFlightRediscovery = modelRegistry
    .loadFromProviders()
    .catch((e: any) => console.warn(`[REDISCOVERY] Refresh failed: ${e?.message ?? e}`))
    .finally(() => { inFlightRediscovery = null; });
  return inFlightRediscovery;
}

/**
 * Resolve providers for a model, transparently refreshing the catalog once if
 * the model is initially unknown. This is the async entry point used by all
 * request paths.
 */
async function resolveProvidersWithDiscovery(
  model: string,
): Promise<Array<{ rp: RegisteredProvider; modelName: string; backendModel: string; priority: number }>> {
  let providers = resolveProvidersForModel(model);
  if (providers.length > 0) return providers;

  await Promise.race([
    refreshModelCatalog(`model "${model}" not found in registry`),
    new Promise<void>(resolve => {
      const t = setTimeout(resolve, REDISCOVERY_WAIT_MS);
      // Never hold the process open just for this deadline timer.
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
  providers = resolveProvidersForModel(model);
  if (providers.length > 0) {
    console.log(`[REDISCOVERY] Model "${model}" resolved after catalog refresh -> ${providers.map(p => p.rp.identity.providerId).join(', ')}`);
  } else {
    console.log(`[REDISCOVERY] Model "${model}" still unresolved after catalog refresh`);
  }
  return providers;
}

/**
 * Logs the full ordered provider-resolution result for a requested model.
 * OpenRouter (or any non-primary provider) will only ever be attempted after the
 * higher-priority providers ahead of it in this list fail.
 */
function logResolvedProviders(
  requested: string,
  providers: Array<{ rp: RegisteredProvider; modelName: string; backendModel: string; priority: number }>,
): void {
  console.log('');
  console.log(`Requested model:    ${requested}`);
  if (providers.length === 0) {
    console.log('Provider candidates: (none)');
    console.log('Resolved providers: (none)');
    console.log('');
    return;
  }
  console.log(`Provider candidates: ${providers.map(p => p.rp.identity.providerId).join(' > ')}`);
  console.log('Resolved providers:');
  providers.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.rp.identity.providerId} (priority=${p.priority}, backendModel=${p.backendModel})`);
  });
  console.log(`Selected provider:  ${providers[0].rp.identity.providerId}`);
  console.log(`Provider priority:  ${providers[0].priority}`);
  console.log(`Backend model:      ${providers[0].backendModel}`);
  console.log(`Base URL:           ${getBaseUrlForProvider(providers[0].rp)}`);
  console.log(`Endpoint:           ${getEndpointForProvider(providers[0].rp)}`);
  console.log('');
}

function logBackendSelection(clientModel: string, providerId: string, backendModel: string): void {
  console.log('');
  console.log(`Requested Model:       ${clientModel}`);
  console.log(`Selected Provider:     ${providerId}`);
  console.log(`Backend Model:         ${backendModel}`);
  console.log('');
}

function logLookup(requested: string, result: string): void {
  const matched = modelRegistry.getProvidersForModel(requested).map(r => `${r.providerId}:${r.model}${r.backendModel && r.backendModel !== r.model ? ` (backend=${r.backendModel})` : ''}`);

  // Show only the entries relevant to this request (by base name and by
  // dot<->dash normalized base) instead of dumping the whole registry, plus any
  // alias entries whose backendModel matches. This makes "why (none)?" obvious.
  const norm = (s: string) => {
    const slash = s.indexOf('/');
    const base = slash > 0 ? s.slice(slash + 1) : s;
    return base.replace(/\./g, '-').toLowerCase();
  };
  const target = norm(requested);
  const candidates: string[] = [];
  const aliases: string[] = [];
  for (const e of modelRegistry.getAllEntries()) {
    const isAlias = !!e.backendModel && e.backendModel !== e.model;
    if (norm(e.model) === target || (e.backendModel && norm(e.backendModel) === target)) {
      const label = `${e.providerId}:${e.model}${isAlias ? ` (alias -> backend=${e.backendModel})` : ''}`;
      candidates.push(label);
      if (isAlias) aliases.push(`${e.model} -> ${e.backendModel} [${e.providerId}]`);
    }
  }

  console.log('');
  console.log(`Requested Model:       ${requested}`);
  console.log(`Normalized base:       ${target}`);
  console.log(`Candidate Entries:     ${candidates.length > 0 ? candidates.join(', ') : '(none)'}`);
  console.log(`Aliases:               ${aliases.length > 0 ? aliases.join(', ') : '(none)'}`);
  console.log(`Matched Providers:     ${matched.length > 0 ? matched.join(', ') : '(none)'}`);
  console.log(`Lookup Result:         ${result}`);
  console.log('');
}

function needsForwardFiltering(rp: RegisteredProvider): boolean {
  return rp.identity.providerId === 'nvidia';
}

function routingLog(providerId: string, model: string, upstreamModel: string, endpoint: string, status: number, latencyMs: number, error?: string): void {
  const ts = new Date().toISOString();
  if (error) {
    console.log(`[ROUTE] ${ts}  Model=${model}  Provider=${providerId}  Upstream=${upstreamModel}  Endpoint=${endpoint}  Status=${status}  Latency=${latencyMs}ms  Error=${error}`);
  } else {
    console.log(`[ROUTE] ${ts}  Model=${model}  Provider=${providerId}  Upstream=${upstreamModel}  Endpoint=${endpoint}  Status=${status}  Latency=${latencyMs}ms`);
  }
}

export function getEndpointForProvider(rp: RegisteredProvider): string {
  switch (rp.identity.providerId) {
    case 'nvidia':
      return config.nvidiaBaseUrl + '/chat/completions';
    case 'openrouter':
      return config.openrouterBaseUrl + '/chat/completions';
    case 'stepfun':
      return config.stepfunBaseUrl.replace(/\/+$/, '') + '/chat/completions';
    case 'glm':
      return config.glmBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'gorouter':
      return config.gorouterBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'inferx':
      return config.inferxBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'onehop':
      return config.onehopBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'orcarouter':
      return config.orcarouterBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'seekai':
      return config.seekaiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'hcnsec':
      return config.hcnsecBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'teamorouter':
      return config.teamorouterBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'groq':
      return config.groqBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'kilo':
      return config.kiloBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'zen':
      return config.zenBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'opencode-inference':
      return config.inferenceBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'logfare':
      return config.logfareBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'empero':
      return config.emperoBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'agentrouter':
      return config.agentrouterBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'tokenharbor':
      return config.tokenharborBaseUrl.replace(/\/+$/, '') + '/v1/chat/completions';

    case 'cline':
      return config.clineBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'codecraftapi':
      return config.codecraftapiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'tabitoken':
      return config.tabitokenBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'bai':
      return config.baiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'unli':
      return config.unliBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'llm7':
      return config.llm7BaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'deepbricks':
      return config.deepbricksBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'bazaarlink':
      return config.bazaarlinkBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'freebuff':
      return config.freebuffBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'vyceai':
      return config.vyceaiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'tokenrouter':
      return config.tokenrouterBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'huggingface':
      return config.huggingfaceBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'gmi':
      return config.gmiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'xkiro':
      return config.xkiroBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'kktoken':
      return config.kktokenBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'kiosapi':
      return config.kiosapiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'nusapi':
      return config.nusapiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'experientiallabs':
      return config.experientiallabsBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'codepus':
      return config.codepusBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'tokenforge':
      return config.tokenforgeBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'atria':
      return config.atriaBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'hive':
      return config.hiveBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'apmix':
      return config.apmixBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'invibuilder':
      return config.invibuilderBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'inception':
      return config.inceptionBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'jiji':
      return config.jijiBaseUrl.replace(/\/+$/, '') + '/chat/completions';

    case 'kie.ai':
      // Multi-route provider: the concrete route path is resolved per model
      // inside the provider (baseUrl + route.path). This diagnostic value
      // intentionally stays at the provider base URL.
      return config.kieBaseUrl.replace(/\/+$/, '') + '/{route}';

    case 'cloudflare':
      return `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/{model}`;
    case 'databricks':
      return '{endpoint}/chat/completions';
    default:
      return 'unknown';
  }
}

export function getBaseUrlForProvider(rp: RegisteredProvider): string {
  switch (rp.identity.providerId) {
    case 'nvidia':
      return config.nvidiaBaseUrl;
    case 'openrouter':
      return config.openrouterBaseUrl;
    case 'stepfun':
      return config.stepfunBaseUrl.replace(/\/+$/, '');
    case 'glm':
      return config.glmBaseUrl.replace(/\/+$/, '');

    case 'gorouter':
      return config.gorouterBaseUrl.replace(/\/+$/, '');

    case 'inferx':
      return config.inferxBaseUrl.replace(/\/+$/, '');

    case 'onehop':
      return config.onehopBaseUrl.replace(/\/+$/, '');

    case 'orcarouter':
      return config.orcarouterBaseUrl.replace(/\/+$/, '');

    case 'seekai':
      return config.seekaiBaseUrl.replace(/\/+$/, '');

    case 'hcnsec':
      return config.hcnsecBaseUrl.replace(/\/+$/, '');

    case 'teamorouter':
      return config.teamorouterBaseUrl.replace(/\/+$/, '');

    case 'groq':
      return config.groqBaseUrl.replace(/\/+$/, '');

    case 'kilo':
      return config.kiloBaseUrl.replace(/\/+$/, '');

    case 'zen':
      return config.zenBaseUrl.replace(/\/+$/, '');

    case 'opencode-inference':
      return config.inferenceBaseUrl.replace(/\/+$/, '');

    case 'logfare':
      return config.logfareBaseUrl.replace(/\/+$/, '');

    case 'empero':
      return config.emperoBaseUrl.replace(/\/+$/, '');

    case 'agentrouter':
      return config.agentrouterBaseUrl.replace(/\/+$/, '');

    case 'tokenharbor':
      return config.tokenharborBaseUrl.replace(/\/+$/, '');

    case 'cline':
      return config.clineBaseUrl.replace(/\/+$/, '');

    case 'codecraftapi':
      return config.codecraftapiBaseUrl.replace(/\/+$/, '');

    case 'tabitoken':
      return config.tabitokenBaseUrl.replace(/\/+$/, '');

    case 'bai':
      return config.baiBaseUrl.replace(/\/+$/, '');

    case 'unli':
      return config.unliBaseUrl.replace(/\/+$/, '');

    case 'llm7':
      return config.llm7BaseUrl.replace(/\/+$/, '');

    case 'deepbricks':
      return config.deepbricksBaseUrl.replace(/\/+$/, '');

    case 'bazaarlink':
      return config.bazaarlinkBaseUrl.replace(/\/+$/, '');

    case 'freebuff':
      return config.freebuffBaseUrl.replace(/\/+$/, '');

    case 'vyceai':
      return config.vyceaiBaseUrl.replace(/\/+$/, '');

    case 'tokenrouter':
      return config.tokenrouterBaseUrl.replace(/\/+$/, '');

    case 'huggingface':
      return config.huggingfaceBaseUrl.replace(/\/+$/, '');

    case 'gmi':
      return config.gmiBaseUrl.replace(/\/+$/, '');

    case 'xkiro':
      return config.xkiroBaseUrl.replace(/\/+$/, '');

    case 'kktoken':
      return config.kktokenBaseUrl.replace(/\/+$/, '');

    case 'kiosapi':
      return config.kiosapiBaseUrl.replace(/\/+$/, '');

    case 'nusapi':
      return config.nusapiBaseUrl.replace(/\/+$/, '');

    case 'experientiallabs':
      return config.experientiallabsBaseUrl.replace(/\/+$/, '');

    case 'codepus':
      return config.codepusBaseUrl.replace(/\/+$/, '');

    case 'tokenforge':
      return config.tokenforgeBaseUrl.replace(/\/+$/, '');

    case 'atria':
      return config.atriaBaseUrl.replace(/\/+$/, '');

    case 'hive':
      return config.hiveBaseUrl.replace(/\/+$/, '');

    case 'apmix':
      return config.apmixBaseUrl.replace(/\/+$/, '');

    case 'invibuilder':
      return config.invibuilderBaseUrl.replace(/\/+$/, '');

    case 'inception':
      return config.inceptionBaseUrl.replace(/\/+$/, '');

    case 'jiji':
      return config.jijiBaseUrl.replace(/\/+$/, '');

    case 'kie.ai':
      return config.kieBaseUrl.replace(/\/+$/, '');

    case 'cloudflare':
      return `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/{model}`;
    case 'databricks':
      return '{endpoint}';
    default:
      return 'unknown';
  }
}

function logOutboundRequest(configuredModel: string, finalModel: string, providerId: string, baseUrl: string): void {
  console.log('');
  console.log(`Configured model: ${configuredModel}`);
  console.log(`Final model:      ${finalModel}`);
  console.log(`Provider:         ${providerId}`);
  console.log(`Base URL:         ${baseUrl}`);
  console.log('');
}

function logAttempt(rp: RegisteredProvider, backendModel: string): void {
  console.log(`Selected provider:  ${rp.identity.providerId}`);
  console.log(`Base URL:           ${getBaseUrlForProvider(rp)}`);
  console.log(`Endpoint:           ${getEndpointForProvider(rp)}`);
  console.log(`Backend model:      ${backendModel}`);
}

function buildPayload(rp: RegisteredProvider, payload: any, backendModel: string): any {
  /* Usage tracking: streaming requests MUST ask the upstream for the final
   * usage chunk (OpenAI `stream_options.include_usage` contract), otherwise
   * OpenAI-compatible upstreams (NVIDIA, Empero, ...) omit `usage` entirely
   * and the request is recorded with null tokens — the usage dashboard then
   * stops accumulating. Applied to EVERY provider here; non-streaming
   * payloads are never given the option. */
  const withStreamUsage =
    payload.stream === true
      ? { ...payload, stream_options: { ...(payload.stream_options ?? {}), include_usage: true } }
      : payload;
  if (needsForwardFiltering(rp)) {
    return forwardPayload({ ...withStreamUsage, model: backendModel });
  }
  return { ...withStreamUsage, model: backendModel, max_tokens: withStreamUsage.max_tokens ?? config.defaultMaxTokens };
}

function logStep(step: string, detail?: string): void {
  console.log(`[STEP] ${step}${detail ? `  ${detail}` : ''}`);
}

/* ─── Provider Cooldown (Provider Management recovery window) ──────────────
 * ONE shared per-provider cooldown (default 180s) coordinating every restart
 * /retry mechanism:
 *  - While a provider is cooling down, requests to it fail fast (429) with a
 *    clear countdown message — no upstream call, no key-loop, no hidden retry.
 *  - There is deliberately NO fallback to another provider because of a
 *    cooldown: provider-locked routing and multi-key rotation are unchanged.
 *  - Cooldown state is PER-PROVIDER: marking one provider never affects
 *    another. A success on the provider clears its own cooldown.
 *  - A provider-level failure is only recorded when the provider's whole
 *    key/endpoint pool is exhausted by rate limits, so normal multi-key
 *    rotation across requests keeps working while keys remain available.
 * ─────────────────────────────────────────────────────────────────────────── */
function markProviderFailure(providerId: string, error: any): void {
  providerCooldown.markFailure(providerId, error);
  const remaining = providerCooldown.remainingMs(providerId);
  const snapshot = providerCooldown.snapshot(providerId);
  console.log(`[COOLDOWN] Provider=${providerId}  Status=${snapshot.lastStatus}  Cooldown=${Math.round(remaining / 1000)}s  Error=${snapshot.lastError ?? 'unknown'}`);
}

function markProviderSuccess(providerId: string): void {
  if (providerCooldown.snapshot(providerId).cooldownUntil !== null) {
    console.log(`[COOLDOWN] Provider=${providerId}  Cleared (upstream success)`);
  }
  providerCooldown.markSuccess(providerId);
}

/** True when the provider's rotation pool has no key/endpoint left to try —
 *  the provider as a whole is exhausted, so rotation cannot help on the next
 *  request either. Providers without any pool are treated as exhausted. */
function isProviderPoolExhausted(providerId: string): boolean {
  const km = getAllKeyManagers()[providerId];
  if (km) return km.availableKeys().length === 0;
  const em = getAllEndpointManagers()[providerId];
  if (em) return em.health().activeEndpoints === 0;
  return true;
}

/** Records a provider-level failure into the cooldown registry — but ONLY for
 *  quota/rate-limit failures when the provider's ENTIRE pool is exhausted.
 *  Single-key 429s (other keys still available) never lock the provider, so
 *  round-robin multi-key failover keeps running exactly as before.
 *
 *  Insufficient-balance failures (402/400 dead credentials) are DELIBERATELY
 *  excluded: dead keys already self-skip via their own per-key cooldown, and
 *  a provider-wide lockout would fail-fast later requests WITHOUT trying the
 *  remaining keys — including funded ones whose short rate-limit just lifted.
 *  Worst case without the lockout is one full key sweep (~fast 402s each)
 *  before the honest error surfaces. */
function noteProviderFailure(providerId: string, error: any): void {
  const quotaLike = isQuotaError(error) || error instanceof AllKeysCooldownError;
  if (!quotaLike) return;
  if (isInsufficientBalanceError(error)) return;
  if (!isProviderPoolExhausted(providerId)) return;
  markProviderFailure(providerId, error);
}

/** Fail-fast guard: throws the cooldown error (429 + countdown) when the
 *  provider must not be attempted yet. Never routes to another provider. */
function assertProviderNotCoolingDown(
  providerId: string,
  model: string,
  endpoint: string,
  requestId: string | null = null,
): void {
  const remaining = providerCooldown.remainingMs(providerId);
  if (remaining <= 0) return;
  const cdError = createProviderCooldownError(providerId, remaining);
  const remainingSec = Math.ceil(remaining / 1000);
  console.log(`[COOLDOWN] Provider=${providerId}  Model=${model}  BLOCKED for ${remainingSec}s more (no retry during cooldown)`);
  routingLog(providerId, model, model, endpoint, cdError.status, 0, `cooldown active, ${remainingSec}s remaining`);
  recordUsageFor(providerId, model, 'blocked', 0, undefined, undefined, cdError.status, cdError.message, requestId);
  throw cdError;
}

/**
 * Logs why routing is falling over from the current (failed) provider to the
 * next one. With provider-locked routing enabled (the default), resolution
 * yields a SINGLE provider, so this only ever logs "no more providers" — key
 * rotation happens inside the provider, never across providers. The multi-entry
 * path remains only for explicit Virtual Routes / legacy mode.
 */
function logFallback(
  providers: Array<{ rp: RegisteredProvider; priority: number }>,
  failedIndex: number,
  error: any,
): void {
  const failed = providers[failedIndex];
  const status = error?.status ?? error?.response?.status ?? 500;
  const reason = `${failed.rp.identity.providerId} failed (status=${status}: ${error?.message ?? 'unknown'})`;
  console.log(`Reason:             ${reason} → strict provider routing, surfacing provider error`);
}

function extractUsageFromResult(result: any): { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } {
  let body: any = result;
  if (typeof result === 'string') {
    try { body = JSON.parse(result); } catch { return { promptTokens: null, completionTokens: null, totalTokens: null }; }
  }
  const u = body?.usage;
  if (!u || typeof u !== 'object') return { promptTokens: null, completionTokens: null, totalTokens: null };
  /* Provider-specific usage formats:
   *  - OpenAI:      prompt_tokens / completion_tokens / total_tokens
   *  - camelCase:   promptTokens / completionTokens / totalTokens
   *  - Anthropic:   input_tokens / output_tokens (Messages API & some proxies)
   * All numeric variants below are accepted so every registered provider's
   * tokens are captured instead of silently recorded as null. */
  const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const promptTokens =
    num(u.prompt_tokens) ??
    num(u.promptTokens) ??
    num(u.input_tokens) ??
    num(u.inputTokens);
  const completionTokens =
    num(u.completion_tokens) ??
    num(u.completionTokens) ??
    num(u.output_tokens) ??
    num(u.outputTokens);
  if (promptTokens === null || completionTokens === null) {
    return { promptTokens, completionTokens, totalTokens: null };
  }
  const totalTokens =
    num(u.total_tokens) ??
    num(u.totalTokens) ??
    promptTokens + completionTokens;
  /* Do not hide upstream discrepancies: if the provider's own total_tokens
     differs from prompt+completion, surface it in the server log. The
     upstream value remains the stored source of truth. */
  if (
    typeof totalTokens === 'number' &&
    typeof promptTokens === 'number' && typeof completionTokens === 'number' &&
    totalTokens !== promptTokens + completionTokens
  ) {
    console.warn(`[Usage] Upstream total_tokens (${totalTokens}) != prompt+completion (${promptTokens + completionTokens}) — keeping upstream value`);
  }
  return { promptTokens, completionTokens, totalTokens };
}

/* ─── Per-client API key attribution ────────────────────────────────────────
 * Routes wrap their handler in runWithClientKeyContext() so every usage
 * record written during the request lifecycle (including deferred stream
 * 'end' callbacks) is attributed to the client key that made it. The store's
 * apiKey/apiKeyMasked usage fields existed but were never populated before. */
const clientKeyContext = new AsyncLocalStorage<{ id: string; maskedKey: string }>();

export function runWithClientKeyContext<T>(fn: () => T, ctx: { id: string; maskedKey: string } | null): T {
  if (!ctx) return fn();
  return clientKeyContext.run(ctx, fn);
}

function recordUsageFor(
  provider: string,
  model: string,
  status: 'success' | 'error' | 'blocked',
  latencyMs: number,
  result?: any,
  apiKey?: string | null,
  httpStatus?: number | null,
  errorMessage?: string | null,
  requestId?: string | null,
  apiKeyMasked?: string | null,
  comboAttribution?: ComboRequestContext | null,
): void {
  try {
    const ck = clientKeyContext.getStore();
    /* COMBO attribution: request paths that already escaped the ALS scope
     * (deferred stream callbacks) pass the captured context explicitly;
     * everything else reads the live context. Only record IDs are stored —
     * never credentials. */
    const combo = comboAttribution !== undefined ? comboAttribution : getComboContext();
    const tokens = extractUsageFromResult(result);
    recordUsage({
      timestamp: Date.now(),
      provider: provider || 'unknown',
      model: model || 'unknown',
      status,
      latencyMs,
      promptTokens: tokens.promptTokens,
      completionTokens: tokens.completionTokens,
      totalTokens: tokens.totalTokens,
      apiKey: apiKey ?? ck?.id ?? null,
      httpStatus: httpStatus ?? null,
      errorMessage: errorMessage ?? null,
      requestId: requestId ?? null,
      apiKeyMasked: apiKeyMasked ?? ck?.maskedKey ?? null,
      comboId: combo?.comboId ?? null,
      providerKeyId: combo?.providerKeyId ?? null,
    });
    /* Combo usage metadata: successful requests through a combo bump its
     * request counter / last-used timestamp (mirrors touchClientKey). */
    if (combo && status === 'success') {
      touchCombo(combo.comboId);
    }
  } catch (err: any) {
    /* Usage recording must never break the request path — but it must never
     * fail SILENTLY either: a swallowed error here is exactly how the
     * dashboard ends up frozen with no visible cause. Log loudly. */
    console.error(
      `[Usage] FAILED to record usage (provider=${provider || 'unknown'} model=${model || 'unknown'} status=${status}):`,
      err?.message ?? err,
    );
  }
}

/* ─── COMBO provider-locked routing ────────────────────────────────────────
 * An active combo pins a client key to ONE provider (+ optionally one of
 * that provider's API keys). When a request runs under a combo:
 *  - the resolved provider list is filtered down to the combo's provider,
 *    so the attempt loop can NEVER fall over to another provider;
 *  - if the combo's provider cannot serve the model (registry drift), the
 *    request fails — routing never silently searches for another provider;
 *  - Virtual Routes are skipped (the explicit combo pin outranks them);
 *  - credential rotation stays inside the provider via the existing
 *    KeyManager multi-key mechanism, pinned to the combo's key when set. */
function applyComboProviderLock<T extends { rp: RegisteredProvider }>(
  providers: T[],
  payload: any,
  requestId: string | null,
): T[] {
  const combo = getComboContext();
  if (!combo) return providers;

  const filtered = providers.filter(p => p.rp.identity.providerId === combo.providerId);
  if (filtered.length === 0) {
    const message = `The model "${payload.model}" is not available. Check your API key configuration.`;
    recordUsageFor(combo.providerId, payload.model, 'blocked', 0, undefined, undefined, 400, message, requestId);
    console.log(`[COMBO] combo=${combo.comboId} model="${payload.model}" provider="${combo.providerId}" is not resolvable — refusing (no cross-provider fallback)`);
    const err: any = new Error(message);
    err.status = 400;
    err.clientSafe = true;
    throw err;
  }

  console.log(`[COMBO] combo=${combo.comboId} → provider "${combo.providerId}" model="${payload.model}" providerKey=${combo.providerKeyId ?? '(provider rotation)'} — provider-locked, no fallback`);
  return filtered;
}

async function tryVirtualRoute<T>(
  payload: any,
  callProvider: (rp: RegisteredProvider, upstreamPayload: any) => Promise<T>,
): Promise<{ result: T; rp: RegisteredProvider; modelName: string; latencyMs: number }> {
  const route = virtualRouter.getRoute(payload.model);
  if (!route) {
    throw new Error(`No virtual route for model "${payload.model}"`);
  }

  const backendOrder = virtualRouter.getBackendOrder(route.virtualModel);
  logStep('5', `Backend order: ${JSON.stringify(backendOrder)} (counter advance 1)`);
  let lastError: any = null;

  for (const backendIdx of backendOrder) {
    const backend = route.backends[backendIdx];
    logStep('6', `Backend selected: provider=${backend.provider} model=${backend.model}`);
    const rp = registry.getProviderById(backend.provider);
    if (!rp) {
      console.log(`[Router]   Virtual Model: ${payload.model}  Backend provider "${backend.provider}" not configured, skipping`);
      continue;
    }

    if (!modelRegistry.hasModel(backend.model, backend.provider)) {
      console.log(`[Router]   Virtual Model: ${payload.model}  Backend "${backend.provider}" does not have model "${backend.model}" in Model Registry, skipping`);
      continue;
    }

    const upstreamPayload = buildPayload(rp, payload, backend.model);
    const start = Date.now();
    console.log(`[MODEL] Virtual Model:      ${payload.model}`);
    console.log(`[MODEL] Selected Backend:   ${backend.provider} (${backend.model})`);
    logStep('7', `HTTP provider called: provider=${backend.provider} url=${getEndpointForProvider(rp)} model=${backend.model}`);

    try {
      const result = await callProvider(rp, upstreamPayload);
      const latency = Date.now() - start;
      virtualRouter.markSuccess(route.virtualModel, backendIdx, latency);
      markProviderSuccess(backend.provider);

      console.log(`[Router]   Virtual Model: ${payload.model}`);
      console.log(`[Router]   Selected Strategy: ${route.strategy}`);
      console.log(`[Router]   Selected Provider: ${backend.provider}`);
      console.log(`[Router]   Upstream Model: ${backend.model}`);
      console.log(`[Router]   Endpoint: ${getEndpointForProvider(rp)}`);
      console.log(`[Router]   Latency: ${latency}ms`);

      return { result, rp, modelName: backend.model, latencyMs: latency };
    } catch (error: any) {
      const latency = Date.now() - start;
      lastError = error;
      const status = error?.status ?? error?.response?.status ?? 500;
      virtualRouter.markFailure(route.virtualModel, backendIdx, error);
      noteProviderFailure(backend.provider, error);

      console.log(`[Router]   Virtual Model: ${payload.model}  Backend ${backend.provider} failed (${status}), trying next`);
      routingLog(backend.provider, backend.model, backend.model, getEndpointForProvider(rp), status, latency, error.message);
    }
  }

  /* The virtual route itself is internal; surface a provider-agnostic error
   * instead of the backend provider's raw error (which names the provider,
   * upstream URL or upstream error body). Never falls back across providers
   * here — backends are tried in order within the virtual route only. */
  if (lastError) {
    const err: any = new Error('The requested model is temporarily unavailable. Please retry later.');
    err.status = lastError?.status ?? lastError?.response?.status ?? 502;
    err.clientSafe = true;
    throw err;
  }
  throw new AllBackendsFailedError(payload.model);
}

async function tryChatCompletion(payload: any, requestId: string | null = null): Promise<{ result: any; rp: RegisteredProvider; modelName: string }> {
  logStep('1', `Incoming model: ${payload.model}`);
  logStep('2', 'tryChatCompletion entered');
  logStep('3', `VirtualRouter.lookup("${payload.model}")`);
  /* COMBO: an explicit combo pin outranks Virtual Routes — skip lookup. */
  const combo = getComboContext();
  const route = combo ? null : virtualRouter.getRoute(payload.model);
  logStep('4', route ? `Virtual route found: ${route.virtualModel} (strategy=${route.strategy}, ${route.backends.length} backends)` : (combo ? 'COMBO active — VirtualRouter SKIPPED' : 'Virtual route NOT found'));
  if (route) {
    const vr = await tryVirtualRoute(payload, (rp, taggedPayload) => rp.instance.chatCompletion(taggedPayload));
    recordUsageFor(vr.rp.identity.providerId, vr.modelName, 'success', vr.latencyMs, vr.result, undefined, 200, undefined, requestId);
    return { result: vr.result, rp: vr.rp, modelName: vr.modelName };
  }

  logStep('2X', 'VirtualRouter SKIPPED → resolve providers from ModelRegistry');
  let providers = await resolveProvidersWithDiscovery(payload.model);
  if (providers.length === 0) {
    recordUsageFor('unknown', payload.model, 'blocked', 0, undefined, undefined, null, null, requestId);
    const err: any = new Error(`The model "${payload.model}" is not available. Check your API key configuration.`);
    err.status = 400;
    err.clientSafe = true;
    throw err;
  }
  /* COMBO: restrict to the combo's provider only — never another provider. */
  providers = applyComboProviderLock(providers, payload, requestId);

  let lastError: any = null;
  let lastErrorLatency = 0;
  /* Index of the ATTEMPT that produced the surfaced error. Attribution must
     follow the actual failing attempt — never assume the last array slot. */
  let lastErrorIndex = -1;
  for (let i = 0; i < providers.length; i++) {
    const { rp, modelName, backendModel } = providers[i];
    /* Cooldown gate: while this provider is in its recovery window the request
     * fails fast with a clear countdown — the upstream is never re-attempted,
     * and routing does NOT silently switch to a different provider. */
    assertProviderNotCoolingDown(rp.identity.providerId, payload.model, getEndpointForProvider(rp), requestId);
    const taggedPayload = buildPayload(rp, payload, backendModel);
    const start = Date.now();
    logStep('3X', `Trying provider ${rp.identity.providerId} for model ${modelName}`);
    logBackendSelection(payload.model, rp.identity.providerId, backendModel);
    logOutboundRequest(payload.model, backendModel, rp.identity.providerId, getBaseUrlForProvider(rp));
    logAttempt(rp, backendModel);
    try {
      const result = await rp.instance.chatCompletion(taggedPayload);
      const latency = Date.now() - start;
      markProviderSuccess(rp.identity.providerId);
      routingLog(rp.identity.providerId, payload.model, backendModel, getEndpointForProvider(rp), 200, latency);
      recordUsageFor(rp.identity.providerId, modelName, 'success', latency, result, undefined, 200, undefined, requestId);
      return { result, rp, modelName };
    } catch (error: any) {
      lastErrorLatency = Date.now() - start;
      lastError = error;
      lastErrorIndex = i;
      noteProviderFailure(rp.identity.providerId, error);
      const status = error?.status ?? error?.response?.status ?? 500;
      routingLog(rp.identity.providerId, payload.model, backendModel, getEndpointForProvider(rp), status, lastErrorLatency, error.message);
      logFallback(providers, i, error);
    }
  }

  if (lastError && lastErrorIndex >= 0) {
    const failedAttempt = providers[lastErrorIndex];
    recordUsageFor(
      failedAttempt.rp.identity.providerId,
      failedAttempt.modelName,
      'error',
      lastErrorLatency,
      lastError?.response?.data,
      undefined,
      lastError?.status ?? lastError?.response?.status ?? 500,
      lastError?.message ?? 'unknown error',
      requestId,
    );
  }
  throw lastError;
}

export async function chatCompletion(payload: any, requestId: string | null = null): Promise<any> {
  const { result } = await tryChatCompletion(payload, requestId);
  return result;
}

async function tryChatCompletionRaw(payload: any, requestId: string | null = null): Promise<{ rawJson: string; rp: RegisteredProvider; modelName: string }> {
  logStep('1', `Incoming model: ${payload.model}`);
  logStep('2', 'tryChatCompletionRaw entered');
  logStep('3', `VirtualRouter.lookup("${payload.model}")`);
  /* COMBO: an explicit combo pin outranks Virtual Routes — skip lookup. */
  const combo = getComboContext();
  const route = combo ? null : virtualRouter.getRoute(payload.model);
  logStep('4', route ? `Virtual route found: ${route.virtualModel} (strategy=${route.strategy})` : (combo ? 'COMBO active — VirtualRouter SKIPPED' : 'Virtual route NOT found'));
  if (route) {
    const vr = await tryVirtualRoute(payload, (rp, taggedPayload) => rp.instance.chatCompletionRaw(taggedPayload));
    recordUsageFor(vr.rp.identity.providerId, vr.modelName, 'success', vr.latencyMs, vr.result, undefined, 200, undefined, requestId);
    return { rawJson: vr.result, rp: vr.rp, modelName: vr.modelName };
  }

  logStep('2X', 'VirtualRouter SKIPPED → resolve providers from ModelRegistry (raw)');
  let providers = await resolveProvidersWithDiscovery(payload.model);
  if (providers.length === 0) {
    recordUsageFor('unknown', payload.model, 'blocked', 0, undefined, undefined, null, null, requestId);
    const err: any = new Error(`The model "${payload.model}" is not available. Check your API key configuration.`);
    err.status = 400;
    err.clientSafe = true;
    throw err;
  }
  /* COMBO: restrict to the combo's provider only — never another provider. */
  providers = applyComboProviderLock(providers, payload, requestId);

  let lastError: any = null;
  let lastErrorLatency = 0;
  /* Track the actual failing attempt (see tryChatCompletion). */
  let lastErrorIndex = -1;
  for (let i = 0; i < providers.length; i++) {
    const { rp, modelName, backendModel } = providers[i];
    /* Cooldown gate (see tryChatCompletion): fail fast, no hidden retry. */
    assertProviderNotCoolingDown(rp.identity.providerId, payload.model, getEndpointForProvider(rp), requestId);
    const taggedPayload = buildPayload(rp, payload, backendModel);
    const start = Date.now();
    logBackendSelection(payload.model, rp.identity.providerId, backendModel);
    logOutboundRequest(payload.model, backendModel, rp.identity.providerId, getBaseUrlForProvider(rp));
    logAttempt(rp, backendModel);
    try {
      const rawJson = await rp.instance.chatCompletionRaw(taggedPayload);
      const latency = Date.now() - start;
      markProviderSuccess(rp.identity.providerId);
      routingLog(rp.identity.providerId, payload.model, backendModel, getEndpointForProvider(rp), 200, latency);
       recordUsageFor(rp.identity.providerId, modelName, 'success', latency, rawJson, undefined, 200, undefined, requestId);
      return { rawJson, rp, modelName };
    } catch (error: any) {
      lastErrorLatency = Date.now() - start;
      lastError = error;
      lastErrorIndex = i;
      noteProviderFailure(rp.identity.providerId, error);
      const status = error?.status ?? error?.response?.status ?? 500;
      routingLog(rp.identity.providerId, payload.model, backendModel, getEndpointForProvider(rp), status, lastErrorLatency, error.message);
      logFallback(providers, i, error);
    }
  }

  if (lastError && lastErrorIndex >= 0) {
    const failedAttempt = providers[lastErrorIndex];
    recordUsageFor(
      failedAttempt.rp.identity.providerId,
      failedAttempt.modelName,
      'error',
      lastErrorLatency,
      lastError?.response?.data,
      undefined,
      lastError?.status ?? lastError?.response?.status ?? 500,
      lastError?.message ?? 'unknown error',
      requestId,
    );
  }
  throw lastError;
}

export async function chatCompletionRaw(payload: any, requestId: string | null = null): Promise<string> {
  const { rawJson } = await tryChatCompletionRaw(payload, requestId);
  return rawJson;
}

async function tryChatCompletionStream(payload: any, requestId: string | null = null): Promise<{ streamData: any; rp: RegisteredProvider; modelName: string }> {
  logStep('1', `Incoming model: ${payload.model}`);
  logStep('2', 'tryChatCompletionStream entered');
  logStep('3', `VirtualRouter.lookup("${payload.model}")`);
  /* Deferred stream 'end' callbacks fire AFTER runWithClientKeyContext's
   * scope has returned — capture the client key now and pass it explicitly. */
  const ck = clientKeyContext.getStore();
  /* Same for the combo routing pin: captured up-front so deferred stream
   * usage records stay combo-attributed. */
  const comboCtx = getComboContext();
  /* COMBO: an explicit combo pin outranks Virtual Routes — skip lookup. */
  const route = comboCtx ? null : virtualRouter.getRoute(payload.model);
  logStep('4', route ? `Virtual route found: ${route.virtualModel} (strategy=${route.strategy})` : (comboCtx ? 'COMBO active — VirtualRouter SKIPPED' : 'Virtual route NOT found'));
  if (route) {
    const start = Date.now();
    const vr = await tryVirtualRoute(payload, (rp, taggedPayload) => rp.instance.chatCompletionStream(taggedPayload));
    const wrapped = wrapStream(vr.result.stream, payload.model);
    wrapped.setInternalTerms([
      vr.rp.identity.providerId,
      vr.rp.identity.providerName,
    ].filter(Boolean));
    wrapped.stream.on('end', () => {
      const usage = wrapped.getUsage();
      recordUsageFor(
        vr.rp.identity.providerId,
        vr.modelName,
        'success',
        Date.now() - start,
        usage ? { usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens } } : undefined,
         ck?.id,
         200,
         undefined,
         requestId,
         ck?.maskedKey,
         comboCtx,
      );
    });
    wrapped.stream.on('error', (err: Error) => {
      /* Mid-stream failure: record an explicit error row (tokens stay null —
       * never estimated). See the non-virtual path below. */
      recordUsageFor(
        vr.rp.identity.providerId,
        vr.modelName,
        'error',
        Date.now() - start,
        undefined,
        ck?.id,
        502,
        err?.message ?? 'stream error',
        requestId,
        ck?.maskedKey,
        comboCtx,
      );
    });
    return { streamData: { stream: wrapped.stream }, rp: vr.rp, modelName: vr.modelName };
  }

  logStep('2X', 'VirtualRouter SKIPPED → resolve providers from ModelRegistry (stream)');
  let providers = await resolveProvidersWithDiscovery(payload.model);
  if (providers.length === 0) {
    recordUsageFor('unknown', payload.model, 'blocked', 0, undefined, undefined, null, null, requestId, undefined, comboCtx);
    const err: any = new Error(`The model "${payload.model}" is not available. Check your API key configuration.`);
    err.status = 400;
    err.clientSafe = true;
    throw err;
  }
  /* COMBO: restrict to the combo's provider only — never another provider. */
  providers = applyComboProviderLock(providers, payload, requestId);

  let lastError: any = null;
  let lastErrorLatency = 0;
  /* Track the actual failing attempt (see tryChatCompletion). */
  let lastErrorIndex = -1;
  for (let i = 0; i < providers.length; i++) {
    const { rp, modelName, backendModel } = providers[i];
    /* Cooldown gate (see tryChatCompletion): fail fast, no hidden retry. */
    assertProviderNotCoolingDown(rp.identity.providerId, payload.model, getEndpointForProvider(rp), requestId);
    const taggedPayload = buildPayload(rp, payload, backendModel);
    const start = Date.now();
    logBackendSelection(payload.model, rp.identity.providerId, backendModel);
    logOutboundRequest(payload.model, backendModel, rp.identity.providerId, getBaseUrlForProvider(rp));
    logAttempt(rp, backendModel);
    try {
      const result = await rp.instance.chatCompletionStream(taggedPayload);
      const latency = Date.now() - start;
      markProviderSuccess(rp.identity.providerId);
      routingLog(rp.identity.providerId, payload.model, backendModel, getEndpointForProvider(rp), 200, latency);
      // Stream usage: capture usage from the final SSE chunk while the stream is
      // piped to the client. Record is deferred until the stream finishes.
      // NVIDIA streaming sends `usage: null` in the final chunk, so tokens stay
      // null here (never estimated/fabricated). Other providers that do send
      // usage in a streamed result are recorded as-is.
      const wrapped = wrapStream(result.stream, payload.model);
      wrapped.setInternalTerms([rp.identity.providerId, rp.identity.providerName].filter(Boolean));
      wrapped.stream.on('end', () => {
        const usage = wrapped.getUsage();
        recordUsageFor(
          rp.identity.providerId,
          modelName,
          'success',
          Date.now() - start,
          usage ? { usage: { prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens } } : undefined,
           ck?.id,
           200,
           undefined,
           requestId,
           ck?.maskedKey,
           comboCtx,
        );
      });
      wrapped.stream.on('error', (err: Error) => {
        /* A stream that established then failed mid-flight is a real
         * (failed) request: record it as an error row so request counts and
         * failure rates stay truthful. Tokens stay null — the usage chunk
         * may never have arrived. */
        recordUsageFor(
          rp.identity.providerId,
          modelName,
          'error',
          Date.now() - start,
          undefined,
          ck?.id,
          502,
          err?.message ?? 'stream error',
          requestId,
          ck?.maskedKey,
          comboCtx,
        );
      });
      return { streamData: { stream: wrapped.stream }, rp, modelName };
    } catch (error: any) {
      lastErrorLatency = Date.now() - start;
      lastError = error;
      lastErrorIndex = i;
      noteProviderFailure(rp.identity.providerId, error);
      const status = error?.status ?? error?.response?.status ?? 500;
      routingLog(rp.identity.providerId, payload.model, backendModel, getEndpointForProvider(rp), status, lastErrorLatency, error.message);
      logFallback(providers, i, error);
    }
  }

  if (lastError && lastErrorIndex >= 0) {
    const failedAttempt = providers[lastErrorIndex];
    recordUsageFor(
      failedAttempt.rp.identity.providerId,
      failedAttempt.modelName,
      'error',
      lastErrorLatency,
      lastError?.response?.data,
      undefined,
      lastError?.status ?? lastError?.response?.status ?? 500,
      lastError?.message ?? 'unknown error',
      requestId,
    );
  }
  throw lastError;
}

export async function chatCompletionStream(payload: any, requestId: string | null = null): Promise<any> {
  const { streamData } = await tryChatCompletionStream(payload, requestId);
  return streamData;
}

export async function listModels(): Promise<any> {
  console.log('[TRACE] Enter services/provider.listModels');

  const allModels: any[] = [];

  /* CLIENT-FACING CATALOG ONLY — sourced from the ModelRegistry's public
   * entries (`reg.model`). Internal backend aliases (admin-declared
   * backendModel ids) and raw upstream discovery ids are NEVER listed:
   * they are routing information, and advertising them would leak the
   * provider's own catalog / backend mapping to clients. The live upstream
   * discovery feeds the REGISTRY (loadFromProviders), not this endpoint. */
  const registered = modelRegistry.getPublicEntries();
  for (const reg of registered) {
    if (registry.isDisabled(reg.providerId)) continue;
    allModels.push({
      id: reg.model,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: reg.providerId,
    });
  }

  for (const vm of virtualRouter.getAllVirtualModels()) {
    allModels.push({
      id: vm,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'virtual',
    });
  }

  const seen = new Set<string>();
  const deduped = allModels.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  if (deduped.length === 0) return null;

  return { object: 'list', data: deduped };
}

export async function createEmbedding(payload: any, requestId: string | null = null): Promise<any> {
  console.log('[TRACE] Enter services/provider.createEmbedding');
  const providers = await resolveProvidersWithDiscovery(payload.model);
  if (providers.length === 0) {
    recordUsageFor('unknown', payload.model, 'blocked', 0, undefined, undefined, null, null, requestId);
    const err: any = new Error(`The model "${payload.model}" is not available. Check your API key configuration.`);
    err.status = 400;
    err.clientSafe = true;
    throw err;
  }

  /* COMBO: restrict to the combo's provider only — never another provider. */
  const comboProviders = applyComboProviderLock(providers, payload, requestId);

  const { rp, modelName, backendModel } = comboProviders[0];
  assertProviderNotCoolingDown(rp.identity.providerId, payload.model, getEndpointForProvider(rp).replace('/chat/completions', '/embeddings'), requestId);
  routingLog(rp.identity.providerId, payload.model, backendModel, getEndpointForProvider(rp).replace('/chat/completions', '/embeddings'), 0, 0);
  logBackendSelection(payload.model, rp.identity.providerId, backendModel);

  const taggedPayload = { ...payload, model: backendModel };

  const start = Date.now();
  try {
    const result = await rp.instance.createEmbedding(taggedPayload);
    const latency = Date.now() - start;
    markProviderSuccess(rp.identity.providerId);
    recordUsageFor(rp.identity.providerId, modelName, 'success', latency, result, undefined, 200, undefined, requestId);
    return result;
  } catch (error: any) {
    noteProviderFailure(rp.identity.providerId, error);
    recordUsageFor(
      rp.identity.providerId,
      modelName,
      'error',
      Date.now() - start,
      error?.response?.data,
      undefined,
      error?.status ?? error?.response?.status ?? 500,
      error?.message ?? 'unknown error',
      requestId,
    );
    throw error;
  }
}

export { modelRegistry };
