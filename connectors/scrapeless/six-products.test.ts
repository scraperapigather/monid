import { assert, assertEquals, assertRejects } from "@std/assert";
import { directTransport, Engine } from "@monid/connector-engine";
import {
    estimateEndpoint,
    loadFixture,
    runEndpoint,
    testSealedUnit,
} from "@shared/testing";

const operations = [
    ["tiktok/user/detail", { unique_id: "example" }],
    ["tiktok/user/work", { sec_uid: "EXAMPLE", count: 1, cursor: "0" }],
    ["tiktok/shop/page", { product_id: "123", region: "gb" }],
] as const;

for (const [path, input] of operations) {
    Deno.test(`six-product scope ${path}: confirmed request rate is USD 0.003`, async () => {
        const unit = await testSealedUnit("scrapeless#" + path);
        const estimate = await estimateEndpoint(unit, { body: { input } });
        assertEquals(estimate.credits, { default: 0.003 });
    });
    Deno.test(`six-product scope ${path}: invalid input does not reach supplier`, async () => {
        const unit = await testSealedUnit("scrapeless#" + path);
        await assertRejects(() =>
            estimateEndpoint(unit, { body: { input: {} } })
        );
    });
}

for (
    const [id, name, charge, failed] of [
        ["tiktok/user/work", "tiktok-user-work", 0.003, false],
        ["tiktok/shop/page", "tiktok-shop-page", 0, true],
        ["ai/copilot", "ai-copilot", 0.002, false],
        ["ai/gemini", "ai-gemini-shopping", 0.0018, false],
        ["amazon/rufus", "amazon-rufus-options", 0.003, false],
        ["ai/aimode", "ai-aimode-fresh", 0.0018, false],
        ["ai/aimode", "ai-aimode-url-fresh", 0, true],
    ] as const
) {
    Deno.test(`six-product scope ${id}: actual recorded result stays honest`, async () => {
        const unit = await testSealedUnit("scrapeless#" + id);
        const fixture = await loadFixture(
            new URL(`./fixtures/recorded-six-${name}.json`, import.meta.url)
                .pathname,
        );
        assertEquals(
            fixture.calls.filter((c) => c.req.method === "POST").length,
            1,
        );
        let consumed = 0;
        const loaded = await new Engine({
            sleep: () => Promise.resolve(),
            transport: directTransport({
                params: () => Promise.resolve({ apiKey: "SYNTHETIC_KEY" }),
                fetch: (url, init) => {
                    const call = fixture.calls[consumed++];
                    assert(call, "No unrecorded request or resubmission");
                    assertEquals(String(url), call.req.url);
                    assertEquals(init?.method ?? "GET", call.req.method);
                    assertEquals(
                        init?.body === undefined
                            ? undefined
                            : JSON.parse(String(init.body)),
                        call.req.body,
                    );
                    return Promise.resolve(
                        Response.json(call.res.body, {
                            status: call.res.status,
                        }),
                    );
                },
            }),
        }).load(unit);
        const result = await loaded.run({ body: fixture.calls[0].req.body! });
        assertEquals(consumed, fixture.calls.length);
        assertEquals(result.isProviderError, failed);
        assertEquals(
            result.usage,
            failed ? { credits: {}, evidence: {} } : {
                credits: { default: charge },
                evidence: id === "ai/gemini" || id === "ai/aimode"
                    ? { base: 1, shopping_enrichment: 0 }
                    : { CALL: 1 },
            },
        );
    });
}

Deno.test("historical native short-share failure is retained, not replayed as current normalized wire", async () => {
    const fixture = await loadFixture(
        new URL(
            "./fixtures/recorded-six-ai-aimode-share-url.json",
            import.meta.url,
        ).pathname,
    );
    assertEquals(fixture.calls[0].req.method, "POST");
    assertEquals(fixture.calls.at(-1)!.res.status, 400);
    assertEquals(
        fixture.calls.filter((c) => c.req.method === "POST").length,
        1,
    );
});

Deno.test("review continuation: four real chains preserve wire inputs, outputs and declared usage", async (t) => {
    for (
        const [id, name, charge, evidence] of [
            ["google/search", "shop-target-discovery", 0.001, { CALL: 1 }],
            ["tiktok/shop/page", "shop-current-0", 0.003, { CALL: 1 }],
            ["ai/aimode", "aimode-public-search-url", 0.0018, {
                base: 1,
                shopping_enrichment: 0,
            }],
            ["ai/gemini", "gemini-product-cards", 0.0018, {
                base: 1,
                shopping_enrichment: 0,
            }],
        ] as const
    ) {
        await t.step(name, async () => {
            const fixture = await loadFixture(
                new URL(
                    `./fixtures/recorded-ready-${name}.json`,
                    import.meta.url,
                )
                    .pathname,
            );
            const unit = await testSealedUnit("scrapeless#" + id);
            assertEquals(
                fixture.calls.filter((call) => call.req.method === "POST")
                    .length,
                1,
            );
            let consumed = 0;
            const loaded = await new Engine({
                sleep: () => Promise.resolve(),
                transport: directTransport({
                    params: () => Promise.resolve({ apiKey: "SYNTHETIC_KEY" }),
                    fetch: (url, init) => {
                        const call = fixture.calls[consumed++];
                        assert(call, "No unrecorded call or task resubmission");
                        assertEquals(String(url), call.req.url);
                        assertEquals(init?.method ?? "GET", call.req.method);
                        assertEquals(
                            init?.body === undefined
                                ? undefined
                                : JSON.parse(String(init.body)),
                            call.req.body,
                        );
                        return Promise.resolve(
                            Response.json(call.res.body, {
                                status: call.res.status,
                            }),
                        );
                    },
                }),
            }).load(unit);
            const result = await loaded.run({
                body: fixture.calls[0].req.body!,
            });
            assertEquals(consumed, fixture.calls.length);
            assertEquals(result.isProviderError, false);
            assertEquals(result.usage, {
                credits: { default: charge },
                evidence,
            });
            const finalBody = fixture.calls[fixture.calls.length - 1].res.body;
            assert(
                finalBody && typeof finalBody === "object" &&
                    !Array.isArray(finalBody),
            );
            // The presentation wrapper must retain the full recorded native answer,
            // including product fields/citations; no cherry-picked success marker.
            assertEquals(
                (result.output as Record<string, unknown>).provider_response,
                finalBody,
            );
        });
    }
});

Deno.test("TikTok Shop: synthetic pending chain charges one request, never per product or poll", async () => {
    const unit = await testSealedUnit("scrapeless#tiktok/shop/page");
    const request = {
        method: "POST" as const,
        url: "https://api.scrapeless.com/api/v1/scraper/request",
        body: {
            actor: "scraper.tiktok.shop.page",
            input: { product_id: "123", region: "gb" },
        },
    };
    const result = await runEndpoint({
        unit,
        input: { body: request.body },
        mode: "replay",
        fixture: {
            name: "synthetic-tiktok-shop-lifecycle",
            description:
                "Synthetic protocol only, not real Shop success or invoice.",
            calls: [
                {
                    req: request,
                    res: { status: 201, body: { taskId: "SHOP1" } },
                },
                {
                    req: {
                        method: "GET",
                        url: "https://api.scrapeless.com/api/v1/scraper/result/SHOP1",
                    },
                    res: { status: 202, body: { status: "running" } },
                },
                {
                    req: {
                        method: "GET",
                        url: "https://api.scrapeless.com/api/v1/scraper/result/SHOP1",
                    },
                    res: {
                        status: 200,
                        body: { product_id: "123", price: {} },
                    },
                },
            ],
        },
    });
    assertEquals(result.usage, {
        credits: { default: 0.003 },
        evidence: { CALL: 1 },
    });
});
