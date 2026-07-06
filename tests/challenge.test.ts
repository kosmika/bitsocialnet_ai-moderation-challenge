import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommunityChallengeSetting } from "@pkcprotocol/pkc-js/dist/node/community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "@pkcprotocol/pkc-js/dist/node/pubsub-messages/types.js";
import type { LocalCommunity } from "@pkcprotocol/pkc-js/dist/node/runtime/node/community/local-community.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChallengeFileFactory from "../src/index.js";

type MockFetch = ReturnType<typeof vi.fn>;

const createModelResponse = (verdict: unknown, status = 200) =>
    new Response(
        JSON.stringify({
            output_text: JSON.stringify(verdict)
        }),
        {
            status,
            headers: { "content-type": "application/json" }
        }
    );

const createNestedResponsesModelResponse = (verdict: unknown) =>
    new Response(
        JSON.stringify({
            output: [
                {
                    content: [
                        {
                            type: "output_text",
                            text: JSON.stringify(verdict)
                        }
                    ]
                }
            ]
        }),
        {
            status: 200,
            headers: { "content-type": "application/json" }
        }
    );

const createChatModelResponse = (verdict: unknown) =>
    new Response(
        JSON.stringify({
            choices: [
                {
                    message: {
                        content: JSON.stringify(verdict)
                    }
                }
            ]
        }),
        {
            status: 200,
            headers: { "content-type": "application/json" }
        }
    );

const createRawResponse = (body: string, status = 200) =>
    new Response(body, {
        status,
        headers: { "content-type": "application/json" }
    });

const createPromptResponse = (body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(body, {
        status,
        headers: { "content-type": "text/markdown; charset=utf-8", ...headers }
    });

const stubFetch = (...responses: Response[]) => {
    const fetchMock = vi.fn();
    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
};

const createCommentRequest = (content: string, overrides: { comment?: Record<string, unknown>; request?: Record<string, unknown> } = {}) =>
    ({
        challengeRequestId: new Uint8Array([1, 2, 3, 4]),
        ...overrides.request,
        comment: {
            content,
            title: "hello",
            link: "https://cdn.example.com/media/image.png?sig=1",
            linkHtmlTagName: "img",
            nsfw: true,
            flairs: [{ text: "meta" }, "announcement"],
            author: {
                address: "author-address-1",
                publicKey: "author-public-key-1"
            },
            timestamp: 1_777_966_066,
            signature: {
                publicKey: "signature-public-key-1",
                signature: "signature-value-1"
            },
            ...overrides.comment
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createReplyRequest = (content: string) =>
    ({
        comment: {
            content,
            parentCid: "parent-1",
            postCid: "post-1"
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createContentEditRequest = (content: string) =>
    ({
        commentEdit: {
            commentCid: "comment-1",
            content
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createDeleteEditRequest = () =>
    ({
        commentEdit: {
            commentCid: "comment-1",
            deleted: true
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const createVoteRequest = () =>
    ({
        vote: {
            commentCid: "comment-1",
            vote: 1
        }
    }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

const community = {
    address: "test.bitsocial.net",
    title: "Test community",
    description: "A community for tests",
    rules: ["No spam", "No sexualized minors"],
    features: { safeForWork: true }
} as unknown as LocalCommunity;

const createCommunityWithDuplicateRows = (rows: unknown[]) =>
    ({
        ...community,
        _dbHandler: {
            _db: {
                prepare: vi.fn(() => ({
                    all: vi.fn(() => rows)
                }))
            }
        }
    }) as unknown as LocalCommunity;

const settings = (options: Record<string, unknown> = {}) =>
    ({
        options: {
            apiUrl: "https://provider.example/v1/responses",
            apiKey: "test-key",
            cachePath: "",
            auditLogPath: "",
            ...options
        }
    }) as CommunityChallengeSetting;

const pendingApprovalSettings = (options: Record<string, unknown> = {}) =>
    ({
        ...settings(options),
        pendingApproval: true
    }) as CommunityChallengeSetting;

const getFetchCall = (fetchMock: MockFetch, index = 0) => fetchMock.mock.calls[index] as [string, RequestInit];

const getRequestBody = (fetchMock: MockFetch, index = 0) =>
    JSON.parse(getFetchCall(fetchMock, index)[1].body as string) as Record<string, unknown>;

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("Bitsocial AI moderation challenge package", () => {
    it("exposes metadata and direct provider option inputs", () => {
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const options = challengeFile.optionInputs.map((input) => input.option);

        expect(challengeFile.type).toBe("text/plain");
        expect(challengeFile.description).toMatch(/AI/i);
        expect(options).toContain("apiUrl");
        expect(options).toContain("apiFormat");
        expect(options).toContain("apiKey");
        expect(options).toContain("model");
        expect(options).toContain("branch");
        expect(options).toContain("prompt");
        expect(options).toContain("promptPath");
        expect(options).toContain("promptUrl");
        expect(options).toContain("promptBearerToken");
        expect(options).toContain("cachePath");
        expect(options).toContain("auditLogPath");
        expect(options).not.toContain("apiKeyEnv");
        expect(options).not.toContain("promptVersion");
        expect(options).not.toContain("serverUrl");
    });

    it("sends direct Responses API requests with community rules and extracted link metadata", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ model: "gpt-test", prompt: "custom prompt" }),
            challengeRequestMessage: createCommentRequest("responses payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = getFetchCall(fetchMock);
        expect(url).toBe("https://provider.example/v1/responses");
        expect(init.headers).toMatchObject({
            authorization: "Bearer test-key",
            "content-type": "application/json"
        });

        const body = getRequestBody(fetchMock);
        expect(body).toMatchObject({
            model: "gpt-test",
            store: false,
            text: {
                format: {
                    type: "json_schema",
                    name: "bitsocial_ai_moderation_verdict",
                    strict: true
                }
            }
        });

        const input = body.input as Array<{ role: string; content: string }>;
        expect(input[0].role).toBe("system");
        expect(input[0].content).toContain("custom prompt");
        expect(input[0].content).not.toContain("Reply moderation policy");
        expect(input[0].content).not.toContain("Global duplicate-thread policy");
        const userPayload = JSON.parse(input[1].content) as Record<string, unknown>;
        expect(userPayload).toEqual({
            instructions: expect.stringContaining("article age or recency rules"),
            community: {
                address: "test.bitsocial.net",
                title: "Test community",
                description: "A community for tests",
                rules: ["No spam", "No sexualized minors"]
            },
            publication: {
                kind: "post",
                content: "responses payload",
                title: "hello",
                link: {
                    url: "https://cdn.example.com/media/image.png?sig=1",
                    domain: "cdn.example.com",
                    path: "/media/image.png",
                    htmlTagName: "img"
                },
                flags: {
                    nsfw: true
                },
                flairs: ["meta", "announcement"],
                submittedAt: {
                    unixSeconds: 1_777_966_066,
                    iso: "2026-05-05T07:27:46.000Z"
                }
            }
        });
        expect(userPayload.community).not.toHaveProperty("features");
        expect(userPayload.publication).not.toHaveProperty("authorAddress");
        expect(userPayload.publication).not.toHaveProperty("authorPublicKey");
        expect(userPayload.publication).not.toHaveProperty("timestamp");
        expect(userPayload.publication).not.toHaveProperty("signaturePublicKey");
        expect(userPayload.publication).not.toHaveProperty("signatureHash");
        expect(userPayload.publication).not.toHaveProperty("challengeRequestIdHash");
        expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain("https://cdn.example.com/media/image.png?sig=1");
    });

    it("adds reply-specific leniency to private prompt requests", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ model: "gpt-test", prompt: "custom prompt" }),
            challengeRequestMessage: createReplyRequest(">>111\nhi john"),
            challengeIndex: 1,
            community: {
                ...community,
                title: "/v/ - Video Games",
                rules: [
                    "All posts should pertain to video games, their consoles, and video game culture. Threads should remain on topic and stay in theme with the board. Don't post off-topic garbage."
                ]
            } as unknown as LocalCommunity
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const body = getRequestBody(fetchMock);
        const input = body.input as Array<{ role: string; content: string }>;
        expect(input[0].content).toContain("custom prompt");
        expect(input[0].content).toContain("Reply moderation policy");
        expect(input[0].content).toContain("Do not return review for a reply solely because it is short");
        expect(input[0].content).not.toContain("Global duplicate-thread policy");

        const userPayload = JSON.parse(input[1].content) as {
            instructions: string;
            publication: Record<string, unknown>;
        };
        expect(userPayload.instructions).toContain("For replies, apply top-level post and thread-starting rules more narrowly");
        expect(userPayload.instructions).toContain("off-topic-looking");
        expect(userPayload.publication).toMatchObject({
            kind: "reply",
            content: ">>111\nhi john"
        });
    });

    it("sends URL date hints and submission time for article-recency rules", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const articleUrl =
            "https://nypost.com/2026/06/09/us-news/karmelo-anthony-convicted-of-fatally-stabbing-austin-metcalf-at-texas-track-meet/";

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ prompt: "private prompt" }),
            challengeRequestMessage: createCommentRequest("article recency payload", {
                comment: {
                    title: "1ST DEGREE MURDER",
                    link: articleUrl,
                    linkHtmlTagName: undefined,
                    timestamp: 1_781_043_119
                }
            }),
            challengeIndex: 1,
            community: {
                ...community,
                title: "/news/ - Current News",
                rules: [
                    "All topics and discussion should be about current news articles.",
                    "News articles should be current; no articles older than 48 hours should be posted."
                ]
            } as unknown as LocalCommunity
        });

        expect(result).toEqual({ success: true });
        const body = getRequestBody(fetchMock);
        const input = body.input as Array<{ role: string; content: string }>;
        const userPayload = JSON.parse(input[1].content) as {
            instructions: string;
            publication: Record<string, unknown>;
        };
        expect(userPayload.instructions).toContain("compare publication.link.dateHint against publication.submittedAt");
        expect(userPayload.publication).toMatchObject({
            kind: "post",
            title: "1ST DEGREE MURDER",
            link: {
                url: articleUrl,
                domain: "nypost.com",
                path: "/2026/06/09/us-news/karmelo-anthony-convicted-of-fatally-stabbing-austin-metcalf-at-texas-track-meet/",
                dateHint: {
                    source: "urlPath",
                    date: "2026-06-09",
                    precision: "day",
                    earliestPossibleAt: "2026-06-09T00:00:00.000Z",
                    latestPossibleAt: "2026-06-09T23:59:59.999Z"
                }
            },
            submittedAt: {
                unixSeconds: 1_781_043_119,
                iso: "2026-06-09T22:11:59.000Z"
            }
        });
        expect(userPayload.publication).not.toHaveProperty("timestamp");
        expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain(articleUrl);
    });

    it("extracts URL date hints from common article path suffixes", async () => {
        const fetchMock = stubFetch(
            createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }),
            createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const articleUrls = ["https://example.com/2026-06-09-article-title", "https://example.com/2026/06/09.html"];

        for (const [index, articleUrl] of articleUrls.entries()) {
            const result = await challengeFile.getChallenge({
                challengeSettings: settings({
                    apiUrl: `https://provider.example/article-date-suffix-${index}`,
                    prompt: "private prompt"
                }),
                challengeRequestMessage: createCommentRequest(`article date suffix ${index}`, {
                    comment: {
                        link: articleUrl,
                        timestamp: 1_781_043_119
                    }
                }),
                challengeIndex: 1,
                community
            });

            expect(result).toEqual({ success: true });
        }

        for (const index of articleUrls.keys()) {
            const body = getRequestBody(fetchMock, index);
            const input = body.input as Array<{ role: string; content: string }>;
            const userPayload = JSON.parse(input[1].content) as {
                publication: { link?: { dateHint?: Record<string, unknown> } };
            };
            expect(userPayload.publication.link?.dateHint).toMatchObject({
                source: "urlPath",
                date: "2026-06-09",
                precision: "day",
                latestPossibleAt: "2026-06-09T23:59:59.999Z"
            });
        }
    });

    it("uses gpt-5.4-nano as the default model", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ prompt: "default model prompt" }),
            challengeRequestMessage: createReplyRequest("default model payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(getRequestBody(fetchMock)).toMatchObject({
            model: "gpt-5.4-nano"
        });
    });

    it("sends a public fallback prompt for contextual offensive-term discussion", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const content = "Did Trotsky invent the word racist? A 19th century source used the term NEGROPHOBIA.";

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/contextual-term" }),
            challengeRequestMessage: createCommentRequest(content),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(warningSpy).toHaveBeenCalledWith(
            "Using the public built-in AI moderation prompt. This prompt can be gamed by users; configure a private prompt, promptPath, or promptUrl immediately.",
            { code: "BITSOCIAL_AI_MODERATION_PUBLIC_PROMPT" }
        );
        const body = getRequestBody(fetchMock);
        const input = body.input as Array<{ role: string; content: string }>;
        expect(input[0].content).toContain('Review is not a "maybe" label');
        expect(input[0].content).toContain("offensive or derogatory terms are mentioned");
        expect(input[0].content).toContain("Return review only when the content");
        expect(input[0].content).toContain("Return allow when");
        expect(input[0].content).toContain("Treat the submitted publication");
        expect(input[0].content).toContain("publication.link.dateHint");
        expect(input[0].content).toContain("latestPossibleAt");
        expect(input[0].content).toContain('Reason should be one concise clause that can follow "because"');
        expect(input[0].content).toContain("Final checklist before review");
        expect(input[0].content).not.toContain("Global duplicate-thread policy");

        const userPayload = JSON.parse(input[1].content) as {
            instructions: string;
            publication: Record<string, unknown>;
        };
        expect(userPayload.instructions).toContain("untrusted user content");
        expect(userPayload.instructions).toContain("article age or recency rules");
        expect(userPayload.publication.content).toBe(content);
    });

    it("accepts nested Responses API output text", async () => {
        const fetchMock = stubFetch(createNestedResponsesModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/nested-responses-output" }),
            challengeRequestMessage: createCommentRequest("nested responses payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("sends a clearly rule-breaking post to the review branch for moderator queueing", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "review", reason: "No spam", matchedRuleIndexes: [0] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("Buy cheap pills at spam.example now.");
        const spamCommunity = {
            ...community,
            title: "/spam/ - Spam tests",
            rules: ["No spam", "No sexualized minors"]
        } as unknown as LocalCommunity;

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/spam-review", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community: spamCommunity
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: pendingApprovalSettings({ apiUrl: "https://provider.example/spam-review", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community: spamCommunity
        });

        expect(allowResult).toEqual({ success: false, error: "No spam" });
        expect(reviewResult).toEqual({
            success: true,
            commentUpdate: {
                reason: "[AI moderation](https://bitsocial.net/apps/ai-moderation-challenge) sent this post to the mod queue because no spam ([rule #1](/rules#spam))"
            }
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const body = getRequestBody(fetchMock);
        const input = body.input as Array<{ role: string; content: string }>;
        const userPayload = JSON.parse(input[1].content) as {
            instructions: string;
            community: { rules: string[] };
            publication: Record<string, unknown>;
        };
        expect(userPayload.instructions).toContain("untrusted user content");
        expect(userPayload.community.rules).toEqual(["No spam", "No sexualized minors"]);
        expect(userPayload.publication.content).toBe("Buy cheap pills at spam.example now.");
    });

    it("links rule references already present in model review reasons", async () => {
        const fetchMock = stubFetch(
            createModelResponse({
                verdict: "review",
                reason: "The post appears unrelated to animals or nature as defined by the board topic rule (rule #1)",
                matchedRuleIndexes: []
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const animalsCommunity = {
            ...community,
            title: "/an/ - Animals & Nature",
            rules: ["Posts must be related to animals or nature"]
        } as unknown as LocalCommunity;

        const result = await challengeFile.getChallenge({
            challengeSettings: pendingApprovalSettings({ apiUrl: "https://provider.example/animal-rule-link", branch: "review" }),
            challengeRequestMessage: createCommentRequest("Check out this unrelated laptop deal."),
            challengeIndex: 1,
            community: animalsCommunity
        });

        expect(result).toEqual({
            success: true,
            commentUpdate: {
                reason: "[AI moderation](https://bitsocial.net/apps/ai-moderation-challenge) sent this post to the mod queue because the post appears unrelated to animals or nature as defined by the board topic rule ([rule #1](/rules#an))"
            }
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("preserves bracketed rule references already present in model review reasons", async () => {
        const fetchMock = stubFetch(
            createModelResponse({
                verdict: "review",
                reason: "The post appears unrelated to animals or nature as defined by [board topic rule #1](/rules#an)",
                matchedRuleIndexes: [0]
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const animalsCommunity = {
            ...community,
            title: "/an/ - Animals & Nature",
            rules: ["Posts must be related to animals or nature"]
        } as unknown as LocalCommunity;

        const result = await challengeFile.getChallenge({
            challengeSettings: pendingApprovalSettings({
                apiUrl: "https://provider.example/existing-animal-rule-link",
                branch: "review"
            }),
            challengeRequestMessage: createCommentRequest("Check out this unrelated laptop deal."),
            challengeIndex: 1,
            community: animalsCommunity
        });

        expect(result).toEqual({
            success: true,
            commentUpdate: {
                reason: "[AI moderation](https://bitsocial.net/apps/ai-moderation-challenge) sent this post to the mod queue because the post appears unrelated to animals or nature as defined by [board topic rule #1](/rules#an)"
            }
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("redacts publication text before adding the review reason to pending approval metadata", async () => {
        const content = "pending approval text should not be echoed";
        const fetchMock = stubFetch(
            createModelResponse({
                verdict: "review",
                reason: `Quoted ${content} in the reason`,
                matchedRuleIndexes: [0]
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: pendingApprovalSettings({ apiUrl: "https://provider.example/redacted-pending-review", branch: "review" }),
            challengeRequestMessage: createCommentRequest(content),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({
            success: true,
            commentUpdate: {
                reason: "[AI moderation](https://bitsocial.net/apps/ai-moderation-challenge) sent this post to the mod queue because quoted [content] in the reason"
            }
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("supports OpenAI-compatible chat-completions endpoints", async () => {
        const fetchMock = stubFetch(createChatModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                apiUrl: "https://provider.example/v1/chat/completions",
                apiFormat: "chat-completions",
                apiKey: "custom-key",
                model: "custom-model"
            }),
            challengeRequestMessage: createCommentRequest("chat payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        const [url, init] = getFetchCall(fetchMock);
        expect(url).toBe("https://provider.example/v1/chat/completions");
        expect(init.headers).toMatchObject({ authorization: "Bearer custom-key" });
        expect(getRequestBody(fetchMock)).toMatchObject({
            model: "custom-model",
            messages: [
                { role: "system", content: expect.stringContaining("automated first-pass moderation") },
                {
                    role: "user",
                    content: expect.stringContaining("untrusted user content")
                }
            ],
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "bitsocial_ai_moderation_verdict",
                    strict: true
                }
            }
        });
        const body = getRequestBody(fetchMock);
        const messages = body.messages as Array<{ role: string; content: string }>;
        const userPayload = JSON.parse(messages[1].content) as { publication: Record<string, unknown> };
        expect(userPayload.publication).not.toHaveProperty("authorAddress");
        expect(userPayload.publication).not.toHaveProperty("authorPublicKey");
        expect(userPayload.publication).not.toHaveProperty("timestamp");
        expect(userPayload.publication).not.toHaveProperty("signaturePublicKey");
        expect(userPayload.publication).not.toHaveProperty("signatureHash");
        expect(userPayload.publication).not.toHaveProperty("challengeRequestIdHash");
    });

    it("can read the private system prompt from a node-local file", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const tempDir = await mkdtemp(join(tmpdir(), "bitsocial-ai-moderation-"));
        const promptPath = join(tempDir, "prompt.md");
        await writeFile(promptPath, "file prompt", "utf8");
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        try {
            const result = await challengeFile.getChallenge({
                challengeSettings: settings({ promptPath }),
                challengeRequestMessage: createCommentRequest("prompt file payload"),
                challengeIndex: 1,
                community
            });

            expect(result).toEqual({ success: true });
            const body = getRequestBody(fetchMock);
            const input = body.input as Array<{ role: string; content: string }>;
            expect(input[0].role).toBe("system");
            expect(input[0].content).toContain("file prompt");
            expect(input[0].content).not.toContain("Global duplicate-thread policy");
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("can fetch the private system prompt from an HTTPS URL with bearer auth", async () => {
        const fetchMock = stubFetch(
            createPromptResponse("# Remote moderation prompt\n\nReturn allow for this test."),
            createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                promptUrl: "https://prompt.example.com/v1/prompts/ai-moderation.md",
                promptBearerToken: "prompt-secret-token"
            }),
            challengeRequestMessage: createCommentRequest("remote prompt payload"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [promptUrl, promptInit] = getFetchCall(fetchMock, 0);
        expect(promptUrl).toBe("https://prompt.example.com/v1/prompts/ai-moderation.md");
        expect(promptInit).toMatchObject({
            method: "GET",
            headers: {
                authorization: "Bearer prompt-secret-token",
                accept: expect.stringContaining("text/plain")
            }
        });

        const [providerUrl, providerInit] = getFetchCall(fetchMock, 1);
        expect(providerUrl).toBe("https://provider.example/v1/responses");
        expect(providerInit.headers).toMatchObject({ authorization: "Bearer test-key" });
        const body = getRequestBody(fetchMock, 1);
        const input = body.input as Array<{ role: string; content: string }>;
        expect(input[0].content).toContain("# Remote moderation prompt");
        expect(input[0].content).not.toContain("Global duplicate-thread policy");
        expect(JSON.stringify(body)).not.toContain("prompt-secret-token");
    });

    it("caches remote prompts without refetching them for every verdict", async () => {
        const fetchMock = stubFetch(
            createPromptResponse("remote cached prompt"),
            createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }),
            createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const promptUrl = "https://prompt.example.com/v1/prompts/cached-ai-moderation.md";

        const firstResult = await challengeFile.getChallenge({
            challengeSettings: settings({ promptUrl }),
            challengeRequestMessage: createCommentRequest("remote prompt cache payload 1"),
            challengeIndex: 1,
            community
        });
        const secondResult = await challengeFile.getChallenge({
            challengeSettings: settings({ promptUrl }),
            challengeRequestMessage: createCommentRequest("remote prompt cache payload 2"),
            challengeIndex: 1,
            community
        });

        expect(firstResult).toEqual({ success: true });
        expect(secondResult).toEqual({ success: true });
        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
            promptUrl,
            "https://provider.example/v1/responses",
            "https://provider.example/v1/responses"
        ]);
    });

    it("uses the last cached remote prompt when refresh fails", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(createPromptResponse("stale-but-usable prompt"))
            .mockResolvedValueOnce(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }))
            .mockRejectedValueOnce(new Error("prompt host unavailable"))
            .mockResolvedValueOnce(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }))
            .mockResolvedValueOnce(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const promptUrl = "https://prompt.example.com/v1/prompts/stale-cache-ai-moderation.md";

        const firstResult = await challengeFile.getChallenge({
            challengeSettings: settings({ promptUrl }),
            challengeRequestMessage: createCommentRequest("remote stale cache payload 1"),
            challengeIndex: 1,
            community
        });
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        const secondResult = await challengeFile.getChallenge({
            challengeSettings: settings({ promptUrl }),
            challengeRequestMessage: createCommentRequest("remote stale cache payload 2"),
            challengeIndex: 1,
            community
        });
        const thirdResult = await challengeFile.getChallenge({
            challengeSettings: settings({ promptUrl }),
            challengeRequestMessage: createCommentRequest("remote stale cache payload 3"),
            challengeIndex: 1,
            community
        });

        expect(firstResult).toEqual({ success: true });
        expect(secondResult).toEqual({ success: true });
        expect(thirdResult).toEqual({ success: true });
        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
            promptUrl,
            "https://provider.example/v1/responses",
            promptUrl,
            "https://provider.example/v1/responses",
            "https://provider.example/v1/responses"
        ]);
        const secondBody = getRequestBody(fetchMock, 3);
        const secondInput = secondBody.input as Array<{ role: string; content: string }>;
        expect(secondInput[0].content).toContain("stale-but-usable prompt");
        const thirdBody = getRequestBody(fetchMock, 4);
        const thirdInput = thirdBody.input as Array<{ role: string; content: string }>;
        expect(thirdInput[0].content).toContain("stale-but-usable prompt");
    });

    it("fails closed when a remote prompt cannot be fetched before any cache exists", async () => {
        const fetchMock = stubFetch(createPromptResponse("not found", 404));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                promptUrl: "https://prompt.example.com/v1/prompts/missing-ai-moderation.md",
                branch: "allow"
            }),
            challengeRequestMessage: createCommentRequest("remote prompt outage"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: false, error: "Remote AI moderation prompt fetch failed (404)" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fails closed when a remote prompt fetch times out before any cache exists", async () => {
        const abortError = new Error("aborted");
        abortError.name = "AbortError";
        const fetchMock = vi.fn().mockRejectedValue(abortError);
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                promptUrl: "https://prompt.example.com/v1/prompts/slow-ai-moderation.md",
                branch: "allow"
            }),
            challengeRequestMessage: createCommentRequest("remote prompt timeout"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: false, error: "Remote AI moderation prompt fetch timed out" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fails closed when a remote prompt advertises an oversized body", async () => {
        const fetchMock = stubFetch(createPromptResponse("too large", 200, { "content-length": "65537" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                promptUrl: "https://prompt.example.com/v1/prompts/oversized-ai-moderation.md",
                branch: "allow"
            }),
            challengeRequestMessage: createCommentRequest("remote prompt oversized"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: false, error: "Remote AI moderation prompt exceeds 65536 bytes" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fails closed when a remote prompt uses a disallowed content type", async () => {
        const fetchMock = stubFetch(createPromptResponse('{"prompt":"not text"}', 200, { "content-type": "application/json" }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                promptUrl: "https://prompt.example.com/v1/prompts/json-ai-moderation.md",
                branch: "allow"
            }),
            challengeRequestMessage: createCommentRequest("remote prompt content type"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({
            success: false,
            error: "Remote AI moderation prompt must be served as plain text or Markdown"
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not follow remote prompt redirects with private prompt auth", async () => {
        const fetchMock = stubFetch(
            createPromptResponse("redirect", 302, {
                location: "https://other.example.com/v1/prompts/ai-moderation.md"
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                promptUrl: "https://prompt.example.com/v1/prompts/redirect-ai-moderation.md",
                promptBearerToken: "prompt-secret-token",
                branch: "allow"
            }),
            challengeRequestMessage: createCommentRequest("remote prompt redirect"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: false, error: "Remote AI moderation prompt fetch failed (302)" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [promptUrl, promptInit] = getFetchCall(fetchMock);
        expect(promptUrl).toBe("https://prompt.example.com/v1/prompts/redirect-ai-moderation.md");
        expect(promptInit).toMatchObject({
            redirect: "manual",
            headers: {
                authorization: "Bearer prompt-secret-token"
            }
        });
    });

    it("sends activity-relative recent top-level posts for duplicate-thread checks", async () => {
        const fetchMock = stubFetch(
            createModelResponse({
                verdict: "review",
                reason: "it appears to duplicate the recent thread PISS PLANET FOUND",
                matchedRuleIndexes: []
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const targetTimestamp = 1_779_431_203;
        const duplicateRows = [
            { title: "Alsomitra macrocarpa flying seed", timestamp: 1_779_425_429, totalTopLevelPosts: 22 },
            { title: "New Species of Chimaera discovered in Coral Sea Marine Park", timestamp: 1_779_334_285, totalTopLevelPosts: 22 },
            { title: "NASA building a Moon Base", timestamp: 1_779_326_702, totalTopLevelPosts: 22 },
            { title: "When an Earth quake Hits Underwater", timestamp: 1_779_254_320, totalTopLevelPosts: 22 },
            { title: "Citheronia moth", timestamp: 1_779_194_919, totalTopLevelPosts: 22 },
            { title: "Simulation of metamorphosis of a frog", timestamp: 1_779_194_425, totalTopLevelPosts: 22 },
            { title: "x ray on obese person", timestamp: 1_779_075_727, totalTopLevelPosts: 22 },
            { title: "toucan skull", timestamp: 1_778_676_368, totalTopLevelPosts: 22 },
            { title: "ufo files", timestamp: 1_778_314_513, totalTopLevelPosts: 22 },
            {
                title: "PISS PLANET FOUND",
                content:
                    "https://www.dexerto.com/entertainment/pee-planet-scientists-discover-distant-planet-with-atmosphere-that-actually-smells-like-urine-3361785/",
                link: "https://www.dexerto.com/cdn-image/wp-content/uploads/2026/05/06/scientists-discover-planet-that-smells-like-pee.jpg",
                linkHtmlTagName: "img",
                timestamp: 1_778_145_650,
                totalTopLevelPosts: 22
            },
            { title: "I HECKING LOVE SCIENCE!!!", timestamp: 1_778_058_341, totalTopLevelPosts: 22 },
            { title: "dont go to australia", timestamp: 1_778_040_695, totalTopLevelPosts: 22 },
            { title: "simplified evolution", timestamp: 1_777_893_412, totalTopLevelPosts: 22 },
            { title: "Science was a mistake", timestamp: 1_774_745_460, totalTopLevelPosts: 22 }
        ];

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                apiUrl: "https://provider.example/recent-duplicate-posts",
                prompt: "private prompt",
                branch: "allow"
            }),
            challengeRequestMessage: createCommentRequest(
                "The oceans on Indias New Home Planet named Indianus are MADE OUT OF PURE URINE",
                {
                    comment: {
                        title: "Indias New Home Planet",
                        timestamp: targetTimestamp,
                        link: "https://metro.co.uk/wp-content/uploads/2026/04/coverimages55636009-0840.jpg",
                        linkHtmlTagName: "img"
                    }
                }
            ),
            challengeIndex: 1,
            community: createCommunityWithDuplicateRows(duplicateRows)
        });

        expect(result).toEqual({ success: false, error: "it appears to duplicate the recent thread PISS PLANET FOUND" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const body = getRequestBody(fetchMock);
        const input = body.input as Array<{ role: string; content: string }>;
        expect(input[0].content).toContain("Global duplicate-thread policy");

        const userPayload = JSON.parse(input[1].content) as {
            community: {
                duplicateCheck: {
                    totalTopLevelPosts: number;
                    recentWindowPostCount: number;
                    recentWindowSeconds: number;
                    recentTopLevelPosts: Array<{ title?: string; ageSeconds: number; link?: { domain?: string; path?: string } }>;
                };
            };
        };
        expect(userPayload.community.duplicateCheck.totalTopLevelPosts).toBe(22);
        expect(userPayload.community.duplicateCheck.recentWindowPostCount).toBe(19);
        expect(userPayload.community.duplicateCheck.recentWindowSeconds).toBeGreaterThan(14 * 24 * 60 * 60);

        const recentPostTitles = userPayload.community.duplicateCheck.recentTopLevelPosts.map((post) => post.title);
        expect(recentPostTitles).toContain("PISS PLANET FOUND");
        expect(recentPostTitles).not.toContain("Science was a mistake");
        expect(userPayload.community.duplicateCheck.recentTopLevelPosts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    title: "PISS PLANET FOUND",
                    link: expect.objectContaining({
                        domain: "www.dexerto.com",
                        path: "/cdn-image/wp-content/uploads/2026/05/06/scientists-discover-planet-that-smells-like-pee.jpg"
                    })
                })
            ])
        );
        expect(JSON.stringify(userPayload.community.duplicateCheck)).not.toContain("author");
    });

    it("retries without duplicate context when a duplicate review is not supported by recent posts", async () => {
        const fetchMock = stubFetch(
            createModelResponse({
                verdict: "review",
                reason: "it appears to duplicate the recent thread There is nothing wrong with wearing socks and sandals",
                matchedRuleIndexes: []
            }),
            createModelResponse({
                verdict: "review",
                reason: "content does not pertain to fashion or apparel",
                matchedRuleIndexes: [0]
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const targetTimestamp = 1_780_000_000;
        const fashionCommunity = {
            ...createCommunityWithDuplicateRows([
                {
                    title: "There is nothing wrong with wearing socks and sandals",
                    timestamp: targetTimestamp - 60,
                    totalTopLevelPosts: 8
                }
            ]),
            address: "fashion-posting.bso",
            title: "/fa/ - Fashion",
            rules: ["Images and discussion should pertain to fashion and apparel"]
        } as unknown as LocalCommunity;

        const result = await challengeFile.getChallenge({
            challengeSettings: pendingApprovalSettings({
                apiUrl: "https://provider.example/unsupported-duplicate-review",
                prompt: "private prompt",
                branch: "review"
            }),
            challengeRequestMessage: createCommentRequest(
                "It's official. MicroStrategy, $MSTR, is now facing its biggest unrealized loss on Bitcoin.",
                {
                    comment: {
                        title: "MicroStrategy faces a Bitcoin loss",
                        timestamp: targetTimestamp,
                        link: "https://pbs.twimg.com/media/example.jpg",
                        linkHtmlTagName: "img"
                    }
                }
            ),
            challengeIndex: 1,
            community: fashionCommunity
        });

        expect(result).toEqual({
            success: true,
            commentUpdate: {
                reason: "[AI moderation](https://bitsocial.net/apps/ai-moderation-challenge) sent this post to the mod queue because content does not pertain to fashion or apparel ([rule #1](/rules#fa))"
            }
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const firstBody = getRequestBody(fetchMock, 0);
        const firstInput = firstBody.input as Array<{ role: string; content: string }>;
        expect(firstInput[0].content).toContain("Global duplicate-thread policy");
        expect(JSON.parse(firstInput[1].content)).toHaveProperty("community.duplicateCheck");

        const retryBody = getRequestBody(fetchMock, 1);
        const retryInput = retryBody.input as Array<{ role: string; content: string }>;
        expect(retryInput[0].content).not.toContain("Global duplicate-thread policy");
        expect(JSON.parse(retryInput[1].content)).not.toHaveProperty("community.duplicateCheck");
    });

    it("keeps duplicate reviews when a mis-cited thread hides supported duplicate evidence", async () => {
        const fetchMock = stubFetch(
            createModelResponse({
                verdict: "review",
                reason: "it appears to duplicate the recent thread There is nothing wrong with wearing socks and sandals",
                matchedRuleIndexes: []
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const targetTimestamp = 1_780_000_000;
        const duplicateLink = `https://x.io/${"a".repeat(600)}`;
        const duplicateRows = [
            {
                title: "There is nothing wrong with wearing socks and sandals",
                timestamp: targetTimestamp - 60,
                totalTopLevelPosts: 8
            },
            {
                title: "Repeated runway image",
                link: duplicateLink,
                linkHtmlTagName: "img",
                timestamp: targetTimestamp - 120,
                totalTopLevelPosts: 8
            }
        ];

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                apiUrl: "https://provider.example/miscited-duplicate-review",
                prompt: "private prompt",
                branch: "allow"
            }),
            challengeRequestMessage: createCommentRequest("new title for same linked item", {
                comment: {
                    title: "Same runway image again",
                    timestamp: targetTimestamp,
                    link: duplicateLink,
                    linkHtmlTagName: "img"
                }
            }),
            challengeIndex: 1,
            community: createCommunityWithDuplicateRows(duplicateRows)
        });

        expect(result).toEqual({
            success: false,
            error: "it appears to duplicate the recent thread Repeated runway image"
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("fails closed when a duplicate-context retry still returns an unsupported duplicate review", async () => {
        const fetchMock = stubFetch(
            createModelResponse({
                verdict: "review",
                reason: "it appears to duplicate the recent thread There is nothing wrong with wearing socks and sandals",
                matchedRuleIndexes: []
            }),
            createModelResponse({
                verdict: "review",
                reason: "it appears to duplicate a recent thread",
                matchedRuleIndexes: []
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const targetTimestamp = 1_780_000_000;

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                apiUrl: "https://provider.example/retry-unsupported-duplicate-review",
                prompt: "private prompt",
                branch: "allow"
            }),
            challengeRequestMessage: createCommentRequest("MicroStrategy Bitcoin loss", {
                comment: {
                    title: "MicroStrategy faces a Bitcoin loss",
                    timestamp: targetTimestamp,
                    link: "https://pbs.twimg.com/media/example.jpg",
                    linkHtmlTagName: "img"
                }
            }),
            challengeIndex: 1,
            community: createCommunityWithDuplicateRows([
                {
                    title: "There is nothing wrong with wearing socks and sandals",
                    timestamp: targetTimestamp - 60,
                    totalTopLevelPosts: 8
                }
            ])
        });

        expect(result).toEqual({
            success: false,
            error: "AI moderation duplicate review lacked recent-post evidence"
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("persists successful verdicts in a JSON cache keyed by prompt hash", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "bitsocial-ai-moderation-cache-"));
        const cachePath = join(tempDir, "verdicts.json");
        const prompt = "json cache private prompt";
        const request = createCommentRequest("json cached comment");
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        try {
            const firstResult = await challengeFile.getChallenge({
                challengeSettings: settings({ cachePath, prompt }),
                challengeRequestMessage: request,
                challengeIndex: 1,
                community
            });

            expect(firstResult).toEqual({ success: true });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const cacheFileText = await readFile(cachePath, "utf8");
            const cacheFile = JSON.parse(cacheFileText) as { version: number; entries: Record<string, unknown> };
            const cacheKeys = Object.keys(cacheFile.entries);
            expect(cacheFile.version).toBe(1);
            expect(cacheKeys).toHaveLength(1);
            expect(cacheKeys[0]).toMatch(/^[a-f0-9]{64}$/);
            expect(cacheFileText).not.toContain(prompt);
            expect(cacheFileText).not.toContain("test-key");

            vi.resetModules();
            const freshFetchMock = vi.fn().mockRejectedValue(new Error("should not call provider"));
            vi.stubGlobal("fetch", freshFetchMock);
            const { default: FreshChallengeFileFactory } = await import("../src/index.js");
            const freshChallengeFile = FreshChallengeFileFactory({} as CommunityChallengeSetting);

            const secondResult = await freshChallengeFile.getChallenge({
                challengeSettings: settings({ cachePath, prompt }),
                challengeRequestMessage: request,
                challengeIndex: 1,
                community
            });

            expect(secondResult).toEqual({ success: true });
            expect(freshFetchMock).not.toHaveBeenCalled();
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("reuses verdicts when only audit identifiers differ", async () => {
        const fetchMock = stubFetch(
            createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }),
            createModelResponse({ verdict: "review", reason: "second call should not run", matchedRuleIndexes: [0] })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const firstRequest = createCommentRequest("same moderation payload", {
            comment: {
                author: { address: "author-address-1", publicKey: "author-public-key-1" },
                timestamp: 1_777_966_066,
                signature: { publicKey: "signature-public-key-1", signature: "signature-value-1" }
            },
            request: { challengeRequestId: new Uint8Array([1, 2, 3, 4]) }
        });
        const secondRequest = createCommentRequest("same moderation payload", {
            comment: {
                author: { address: "author-address-2", publicKey: "author-public-key-2" },
                timestamp: 1_777_966_066,
                signature: { publicKey: "signature-public-key-2", signature: "signature-value-2" }
            },
            request: { challengeRequestId: new Uint8Array([9, 8, 7, 6]) }
        });

        const firstResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/audit-identifier-cache" }),
            challengeRequestMessage: firstRequest,
            challengeIndex: 1,
            community
        });
        const secondResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/audit-identifier-cache" }),
            challengeRequestMessage: secondRequest,
            challengeIndex: 1,
            community
        });

        expect(firstResult).toEqual({ success: true });
        expect(secondResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not reuse cached verdicts when submission time differs", async () => {
        const fetchMock = stubFetch(
            createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }),
            createModelResponse({ verdict: "review", reason: "second timestamp should run", matchedRuleIndexes: [0] })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const firstRequest = createCommentRequest("same content different timestamp", {
            comment: { timestamp: 1_777_966_066 }
        });
        const secondRequest = createCommentRequest("same content different timestamp", {
            comment: { timestamp: 1_777_966_999 }
        });

        const firstResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/submission-time-cache" }),
            challengeRequestMessage: firstRequest,
            challengeIndex: 1,
            community
        });
        const secondResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/submission-time-cache" }),
            challengeRequestMessage: secondRequest,
            challengeIndex: 1,
            community
        });

        expect(firstResult).toEqual({ success: true });
        expect(secondResult).toEqual({ success: false, error: "second timestamp should run" });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("writes private audit entries without raw prompts, API keys, or publication content", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "bitsocial-ai-moderation-audit-"));
        const cachePath = join(tempDir, "verdicts.json");
        const auditLogPath = join(tempDir, "audit.jsonl");
        const prompt = "audit private prompt";
        const content = "audit raw publication content";
        const fetchMock = stubFetch(
            createModelResponse({
                verdict: "review",
                reason: `Quoted ${content} in the reason`,
                matchedRuleIndexes: [0]
            })
        );
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        try {
            const result = await challengeFile.getChallenge({
                challengeSettings: settings({ cachePath, auditLogPath, prompt, branch: "allow" }),
                challengeRequestMessage: createCommentRequest(content),
                challengeIndex: 1,
                community
            });

            expect(result).toEqual({ success: false, error: "Quoted [content] in the reason" });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const cacheFileText = await readFile(cachePath, "utf8");
            expect(cacheFileText).not.toContain(prompt);
            expect(cacheFileText).not.toContain("test-key");
            expect(cacheFileText).not.toContain(content);
            expect(cacheFileText).toContain("[content]");

            const auditLogText = await readFile(auditLogPath, "utf8");
            const entries = auditLogText
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(entries).toHaveLength(1);
            expect(auditLogText).not.toContain(prompt);
            expect(auditLogText).not.toContain("test-key");
            expect(auditLogText).toContain(content);
            expect(entries[0]).toMatchObject({
                version: 1,
                source: "provider",
                action: "queued_for_review",
                provider: {
                    apiHost: "provider.example",
                    apiFormat: "responses",
                    model: "gpt-5.4-nano"
                },
                publication: {
                    kind: "post",
                    content,
                    title: "hello",
                    linkDomain: "cdn.example.com",
                    linkUrl: "https://cdn.example.com/media/image.png?sig=1",
                    authorAddress: "author-address-1",
                    authorPublicKey: "author-public-key-1",
                    timestamp: 1_777_966_066,
                    signaturePublicKey: "signature-public-key-1"
                },
                verdict: {
                    verdict: "review",
                    reason: `Quoted ${content} in the reason`,
                    matchedRuleIndexes: [0]
                }
            });
            expect(entries[0]).toHaveProperty("cacheKey");
            expect(entries[0]).toHaveProperty("promptHash");
            expect(entries[0]).toHaveProperty("publication.contentHash");
            expect(entries[0]).toHaveProperty("publication.signatureHash");
            expect(entries[0]).toHaveProperty("publication.challengeRequestIdHash");
            expect(auditLogText).not.toContain("signature-value-1");
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });

    it("publishes comments on allow verdict through the allow branch", async () => {
        stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/allow-comment", branch: "allow" }),
            challengeRequestMessage: createCommentRequest("allowed comment"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it("routes review comments through the review branch and reuses the cached verdict", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "review", reason: "Rule 1", matchedRuleIndexes: [0] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("cached review comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/review-comment-cache", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/review-comment-cache", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: false, error: "Rule 1" });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("allows content edits on allow verdict", async () => {
        stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/allow-edit", branch: "allow" }),
            challengeRequestMessage: createContentEditRequest("clean edit"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it("rejects content edits on review verdict for both branches", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "review", reason: "Edit breaks rules", matchedRuleIndexes: [1] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createContentEditRequest("bad edit");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/review-edit", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/review-edit", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: false, error: "Edit breaks rules" });
        expect(reviewResult).toEqual({ success: false, error: "Edit breaks rules" });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["delete-only edits", createDeleteEditRequest()],
        ["votes", createVoteRequest()]
    ])("bypasses %s without calling the API", async (_label, request) => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "review", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: true });
        expect(reviewResult).toEqual({ success: false, error: "AI moderation review branch skipped." });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails open to the review branch for comment API outages", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("outage comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/comment-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/comment-outage", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({ success: false, error: "network down" });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("routes comments to review when the provider returns an error response", async () => {
        const fetchMock = stubFetch(createRawResponse(JSON.stringify({ error: "rate limited" }), 429));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("provider error comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/provider-error", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/provider-error", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({
            success: false,
            error: 'AI moderation API error (429): {"error":"rate limited"}'
        });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("expires failed API calls after the branch pair can reuse them", async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new Error("network down"))
            .mockResolvedValueOnce(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("retry after outage");

        const firstResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/retry-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const immediateResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/retry-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });

        expect(firstResult).toEqual({ success: false, error: "network down" });
        expect(immediateResult).toEqual({ success: false, error: "network down" });
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        const retryResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/retry-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });

        expect(retryResult).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects content edits on API outages", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
        vi.stubGlobal("fetch", fetchMock);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createContentEditRequest("edit during outage");

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/edit-outage", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: false, error: "Rejected by Bitsocial AI moderation." });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("treats invalid API responses as moderation outages", async () => {
        stubFetch(createRawResponse("not-json"));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/invalid-response", branch: "review" }),
            challengeRequestMessage: createCommentRequest("invalid response comment"),
            challengeIndex: 2,
            community
        });

        expect(result).toEqual({ success: true });
    });

    it.each([
        ["missing output text", {}],
        ["non-JSON output text", { output_text: "not-json" }],
        ["invalid verdict JSON", { output_text: JSON.stringify({ verdict: "maybe", reason: "", matchedRuleIndexes: [] }) }]
    ])("treats %s as a moderation outage", async (_label, body) => {
        const fetchMock = stubFetch(createRawResponse(JSON.stringify(body)));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const slug = _label.replaceAll(" ", "-");

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: `https://provider.example/malformed-model-output-${slug}`, branch: "review" }),
            challengeRequestMessage: createCommentRequest(`malformed model output ${_label}`),
            challengeIndex: 2,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("routes comments to review when the API key is missing", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);
        const request = createCommentRequest("missing key comment");

        const allowResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/missing-key", apiKey: "", branch: "allow" }),
            challengeRequestMessage: request,
            challengeIndex: 1,
            community
        });
        const reviewResult = await challengeFile.getChallenge({
            challengeSettings: settings({ apiUrl: "https://provider.example/missing-key", apiKey: "", branch: "review" }),
            challengeRequestMessage: request,
            challengeIndex: 2,
            community
        });

        expect(allowResult).toEqual({
            success: false,
            error: "AI moderation API key is not configured in challenge options"
        });
        expect(reviewResult).toEqual({ success: true });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns safe failures for invalid options", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: { options: { branch: "maybe" } } as CommunityChallengeSetting,
            challengeRequestMessage: createCommentRequest("invalid options"),
            challengeIndex: 1,
            community
        });

        expect(result).toHaveProperty("success", false);
        expect((result as { error?: string }).error).toMatch(/Invalid challenge options/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("requires remote prompt URLs to use HTTPS", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({ promptUrl: "http://prompt.example.com/v1/prompts/ai-moderation.md" }),
            challengeRequestMessage: createCommentRequest("invalid prompt url"),
            challengeIndex: 1,
            community
        });

        expect(result).toHaveProperty("success", false);
        expect((result as { error?: string }).error).toContain("Prompt URL must use https");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("uses inline prompt and warns when both prompt options are configured", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        const result = await challengeFile.getChallenge({
            challengeSettings: settings({
                prompt: "inline",
                promptPath: "/tmp/nonexistent-ai-moderation-prompt.md",
                promptUrl: "https://prompt.example.com/v1/prompts/ignored-ai-moderation.md"
            }),
            challengeRequestMessage: createCommentRequest("ambiguous prompt"),
            challengeIndex: 1,
            community
        });

        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(warningSpy).toHaveBeenCalledWith(
            "`prompt` takes priority, so ai-moderation-challenge is using `prompt` and ignoring `promptPath`/`promptUrl`.",
            { code: "BITSOCIAL_AI_MODERATION_PROMPT_PRECEDENCE" }
        );
        const body = getRequestBody(fetchMock);
        const input = body.input as Array<{ role: string; content: string }>;
        expect(input[0].role).toBe("system");
        expect(input[0].content).toContain("inline");
        expect(input[0].content).not.toContain("Global duplicate-thread policy");
    });

    it("uses promptPath before promptUrl and warns about URL precedence", async () => {
        const fetchMock = stubFetch(createModelResponse({ verdict: "allow", reason: "", matchedRuleIndexes: [] }));
        const warningSpy = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
        const tempDir = await mkdtemp(join(tmpdir(), "bitsocial-ai-moderation-"));
        const promptPath = join(tempDir, "prompt.md");
        await writeFile(promptPath, "path prompt", "utf8");
        const challengeFile = ChallengeFileFactory({} as CommunityChallengeSetting);

        try {
            const result = await challengeFile.getChallenge({
                challengeSettings: settings({
                    promptPath,
                    promptUrl: "https://prompt.example.com/v1/prompts/ignored-path-ai-moderation.md"
                }),
                challengeRequestMessage: createCommentRequest("prompt path precedence"),
                challengeIndex: 1,
                community
            });

            expect(result).toEqual({ success: true });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(["https://provider.example/v1/responses"]);
            expect(warningSpy).toHaveBeenCalledWith(
                "`promptPath` takes priority, so ai-moderation-challenge is using `promptPath` and ignoring `promptUrl`.",
                { code: "BITSOCIAL_AI_MODERATION_PROMPT_PATH_PRECEDENCE" }
            );
            const body = getRequestBody(fetchMock);
            const input = body.input as Array<{ role: string; content: string }>;
            expect(input[0].content).toContain("path prompt");
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});
