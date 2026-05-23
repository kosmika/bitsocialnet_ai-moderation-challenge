import { z } from "zod";

export const DEFAULT_API_URL = "https://api.openai.com/v1/responses";
export const DEFAULT_MODEL = "gpt-5.4-nano";
export const DEFAULT_CACHE_PATH = "~/.bitsocial-ai-moderation-cache.json";
export const DEFAULT_AUDIT_LOG_PATH = "~/.bitsocial-ai-moderation-audit.jsonl";
export const DEFAULT_ERROR = "Rejected by Bitsocial AI moderation.";

export const BranchSchema = z.enum(["allow", "review"]);
export const ApiFormatSchema = z.enum(["responses", "chat-completions"]);

export const ModelVerdictSchema = z
    .object({
        verdict: BranchSchema,
        reason: z.string().optional(),
        matchedRuleIndexes: z.array(z.number().int().nonnegative()).optional()
    })
    .strict();

export type Branch = z.infer<typeof BranchSchema>;
export type ApiFormat = z.infer<typeof ApiFormatSchema>;
export type ModelVerdict = z.infer<typeof ModelVerdictSchema>;

export type ParsedOptions = {
    apiUrl: string;
    apiFormat: ApiFormat;
    apiKey?: string;
    model: string;
    branch: Branch;
    prompt?: string;
    promptPath?: string;
    promptUrl?: string;
    promptBearerToken?: string;
    cachePath?: string;
    auditLogPath?: string;
    error: string;
};

type OptionName = keyof ParsedOptions;

type OptionInput = {
    option: OptionName;
    default: string;
};

const normalizeUrl = (url: string) => url.replace(/\/+$/, "");

const isHttpUrl = (value: string) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
};

const isHttpsUrl = (value: string) => {
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
};

export const createOptionsSchema = (optionInputs: ReadonlyArray<OptionInput>) => {
    const optionDefaults = optionInputs.reduce(
        (acc, input) => {
            acc[input.option] = input.default;
            return acc;
        },
        {} as Record<OptionName, string>
    );

    const getOptionDefault = (option: OptionName) => optionDefaults[option];

    const resolveOptionString = (value: unknown, option: OptionName) => {
        if (typeof value === "string") {
            const trimmed = value.trim();
            return trimmed ? trimmed : getOptionDefault(option);
        }
        if (value === undefined || value === null) {
            return getOptionDefault(option);
        }
        return value;
    };

    const resolveOptionalOptionString = (
        value: unknown,
        option: OptionName,
        { emptyStringDisablesDefault = false }: { emptyStringDisablesDefault?: boolean } = {}
    ) => {
        if (emptyStringDisablesDefault && typeof value === "string" && value.trim() === "") {
            return undefined;
        }
        const resolved = resolveOptionString(value, option);
        if (typeof resolved !== "string") return resolved;
        const trimmed = resolved.trim();
        return trimmed ? trimmed : undefined;
    };

    const schema: z.ZodType<ParsedOptions> = z.preprocess(
        (value) => (value && typeof value === "object" ? value : {}),
        z.object({
            apiUrl: z.preprocess(
                (value) => {
                    const resolved = resolveOptionString(value, "apiUrl");
                    return typeof resolved === "string" ? normalizeUrl(resolved) : resolved;
                },
                z.url().refine(isHttpUrl, {
                    message: "API URL must use http or https"
                })
            ),
            apiFormat: z.preprocess((value) => {
                const resolved = resolveOptionString(value, "apiFormat");
                return typeof resolved === "string" ? resolved.trim().toLowerCase() : resolved;
            }, ApiFormatSchema),
            apiKey: z.preprocess((value) => resolveOptionalOptionString(value, "apiKey"), z.string().optional()),
            model: z.preprocess((value) => resolveOptionString(value, "model"), z.string().min(1)),
            branch: z.preprocess((value) => {
                const resolved = resolveOptionString(value, "branch");
                return typeof resolved === "string" ? resolved.trim().toLowerCase() : resolved;
            }, BranchSchema),
            prompt: z.preprocess((value) => resolveOptionalOptionString(value, "prompt"), z.string().optional()),
            promptPath: z.preprocess((value) => resolveOptionalOptionString(value, "promptPath"), z.string().optional()),
            promptUrl: z.preprocess(
                (value) => {
                    const resolved = resolveOptionalOptionString(value, "promptUrl");
                    return typeof resolved === "string" ? normalizeUrl(resolved) : resolved;
                },
                z
                    .url()
                    .refine(isHttpsUrl, {
                        message: "Prompt URL must use https"
                    })
                    .optional()
            ),
            promptBearerToken: z.preprocess((value) => resolveOptionalOptionString(value, "promptBearerToken"), z.string().optional()),
            cachePath: z.preprocess(
                (value) => resolveOptionalOptionString(value, "cachePath", { emptyStringDisablesDefault: true }),
                z.string().optional()
            ),
            auditLogPath: z.preprocess(
                (value) => resolveOptionalOptionString(value, "auditLogPath", { emptyStringDisablesDefault: true }),
                z.string().optional()
            ),
            error: z.preprocess((value) => resolveOptionString(value, "error"), z.string())
        })
    );

    return schema;
};
