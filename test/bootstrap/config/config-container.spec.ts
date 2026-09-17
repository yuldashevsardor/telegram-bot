import { expect } from "chai";
import { ConfigContainer } from "app/bootstrap/config/config-container";
import { ConfigContainerIsNotInitialized } from "app/bootstrap/config/config-container.errors";
import type { ConfigBuilder } from "app/bootstrap/config/builder/config-builder";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { WatchableConfigStorage } from "app/bootstrap/config/storage/watchable-config-storage";
import type { RawConfig } from "app/bootstrap/config/config-container.types";
import { InvalidConfigError } from "app/shared/errors";

type Values = {
    tempDir: string;
    limits: {
        common: { number: number; interval: number };
    };
};

function storage(raw: RawConfig): ConfigStorage {
    return { load: async (): Promise<RawConfig> => raw, stop: (): void => undefined };
}

// Билдер отдаёт то, что ему дали, без разбора: форма значений здесь расходится с объявленной
// намеренно — именно такое расхождение get() и ловит, компилятор его не видит.
function returning(values: object): ConfigBuilder<Values> {
    return { build: (): Values => values as Values };
}

async function container(values: object): Promise<ConfigContainer<Values>> {
    const cc = new ConfigContainer<Values>(storage({}), returning(values));
    await cc.init();

    return cc;
}

// Источник со сменным снимком и наблюдением: сигнал подаётся вручную, чтобы пересборка не
// зависела ни от файловой системы, ни от интервала опроса.
class FakeWatchableStorage implements WatchableConfigStorage {
    public raw: RawConfig = {};
    public loads = 0;
    public watchCalls = 0;
    public stopCalls = 0;

    private onChanged: (() => void) | null = null;
    private held: Promise<void> | null = null;

    public async load(): Promise<RawConfig> {
        this.loads += 1;

        if (this.held !== null) {
            await this.held;
        }

        return this.raw;
    }

    public watch(onChanged: () => void): void {
        this.watchCalls += 1;
        this.onChanged = onChanged;
    }

    public stop(): void {
        this.stopCalls += 1;
        this.onChanged = null;
    }

    public signal(): void {
        if (this.onChanged === null) {
            expect.fail("the storage was signalled while nobody was watching it");
        }

        this.onChanged();
    }

    // Держит load() до вызова отданной функции: так спека успевает подать сигналы посреди идущей
    // пересборки.
    public holdLoads(): () => void {
        let release = (): void => undefined;

        this.held = new Promise<void>((resolve) => {
            release = (): void => resolve();
        });

        return (): void => {
            this.held = null;
            release();
        };
    }
}

// Собирает значения из снимка, как настоящий билдер: пересборка обязана увидеть смену снимка.
const fromRaw: ConfigBuilder<Values> = {
    build: (raw): Values => ({
        tempDir: raw["TEMP_DIR"] ?? "/tmp",
        limits: {
            common: {
                number: Number(raw["NUMBER"] ?? "1"),
                interval: Number(raw["INTERVAL"] ?? "1000"),
            },
        },
    }),
};

type Watched = {
    cc: ConfigContainer<Values>;
    storage: FakeWatchableStorage;
};

async function watched(raw: RawConfig = {}, builder: ConfigBuilder<Values> = fromRaw): Promise<Watched> {
    const storage = new FakeWatchableStorage();
    storage.raw = raw;

    const cc = new ConfigContainer<Values>(storage, builder);
    await cc.init();

    return { cc: cc, storage: storage };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Пересборку по сигналу дождаться промисом нельзя: колбэк наблюдателя ничего не возвращает.
// Поэтому спека ждёт прокрутки очереди задач — к сроку таймера пересборка на фейковом источнике
// (его load() не уходит за пределы процесса) уже закончена вместе с рассылкой.
async function signalled(storage: FakeWatchableStorage): Promise<void> {
    storage.signal();

    await sleep(0);
}

async function waitFor(done: () => boolean): Promise<void> {
    const deadline = Date.now() + 1000;

    while (!done()) {
        if (Date.now() > deadline) {
            expect.fail("the rebuild did not happen in time");
        }

        await sleep(1);
    }
}

describe("ConfigContainer", () => {
    it("builds the values from what the storage has loaded", async () => {
        const builder: ConfigBuilder<Values> = {
            build: (raw): Values => ({ tempDir: raw["TEMP_DIR"] ?? "", limits: { common: { number: 1, interval: 1 } } }),
        };
        const cc = new ConfigContainer<Values>(storage({ TEMP_DIR: "/data/tmp" }), builder);

        await cc.init();

        expect(cc.get("tempDir")).to.equal("/data/tmp");
    });

    it("throws ConfigContainerIsNotInitialized before init()", () => {
        const cc = new ConfigContainer<Values>(storage({}), returning({ tempDir: "/tmp" }));

        expect(() => cc.get("tempDir"))
            .to.throw(ConfigContainerIsNotInitialized)
            .with.property("message", "ConfigContainer is not initialized, call init() first.");
    });

    it("resolves a dotted path", async () => {
        const common = { number: 30, interval: 1000 };
        const cc = await container({ tempDir: "/tmp", limits: { common: common } });

        expect(cc.get("limits.common")).to.equal(common);
        expect(cc.get("limits.common.interval")).to.equal(1000);
        expect(cc.get("tempDir")).to.equal("/tmp");
    });

    it("throws InvalidConfigError when the value is undefined", async () => {
        const cc = await container({});

        expect(() => cc.get("tempDir"))
            .to.throw(InvalidConfigError, 'Invalid config "tempDir"')
            .with.property("payload")
            .that.deep.equals({ path: "tempDir" });
    });

    it("throws InvalidConfigError when an object on the path is missing", async () => {
        const cc = await container({});

        expect(() => cc.get("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });

    // typeof null — тоже "object": без отдельной проверки на null обход упал бы TypeError.
    it("throws InvalidConfigError when an object on the path is null", async () => {
        const cc = await container({ limits: null });

        expect(() => cc.get("limits.common"))
            .to.throw(InvalidConfigError)
            .with.property("payload")
            .that.deep.equals({ path: "limits.common" });
    });

    describe("init()", () => {
        // Наблюдение заводит сама сборка: отдельный вызов можно забыть, и конфигурация молча
        // осталась бы на значениях старта.
        it("starts watching a storage that reports changes", async () => {
            const { storage } = await watched();

            expect(storage.watchCalls).to.equal(1);
        });

        // За process.env следить нечем, и это не отказ: контейнер с таким источником остаётся на
        // значениях старта.
        it("accepts a storage that cannot report changes", async () => {
            const cc = await container({ tempDir: "/tmp" });

            expect(cc.get("tempDir")).to.equal("/tmp");
        });
    });

    describe("stop()", () => {
        it("stops the storage", async () => {
            const { cc, storage } = await watched();

            cc.stop();

            expect(storage.stopCalls).to.equal(1);
        });

        it("stops a storage that cannot report changes too", async () => {
            let stops = 0;
            const cc = new ConfigContainer<Values>(
                { load: async (): Promise<RawConfig> => ({}), stop: (): void => void (stops += 1) },
                returning({ tempDir: "/tmp" }),
            );

            await cc.init();
            cc.stop();

            expect(stops).to.equal(1);
        });
    });

    describe("rebuild on a signal from the storage", () => {
        it("calls the listener of a changed leaf with the new and the old value", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const calls: Array<[string, string]> = [];

            cc.onChange("tempDir", (newValue, oldValue) => {
                calls.push([newValue, oldValue]);
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(calls).to.deep.equal([["/data/next", "/data"]]);
            expect(cc.get("tempDir")).to.equal("/data/next");
        });

        // Подписка на поддерево — на весь набор значений разом: слушателю лимитов важно, что
        // изменилось хоть что-то внутри, а не какой именно лист.
        it("calls the listener of a subtree when a value inside it changes", async () => {
            const { cc, storage } = await watched({ NUMBER: "1" });
            const calls: Array<[unknown, unknown]> = [];

            cc.onChange("limits", (newValue, oldValue) => {
                calls.push([newValue, oldValue]);
            });

            storage.raw = { NUMBER: "2" };
            await signalled(storage);

            expect(calls).to.deep.equal([[{ common: { number: 2, interval: 1000 } }, { common: { number: 1, interval: 1000 } }]]);
        });

        // Один вызов на пересборку, а не по вызову на каждый изменившийся лист внутри: пути
        // собираются в набор, поэтому путь поддерева встречается в нём один раз.
        it("calls the listener of a subtree once when two values inside it change", async () => {
            const { cc, storage } = await watched({ NUMBER: "1", INTERVAL: "1000" });
            let calls = 0;

            cc.onChange("limits", () => {
                calls += 1;
            });

            storage.raw = { NUMBER: "2", INTERVAL: "2000" };
            await signalled(storage);

            expect(calls).to.equal(1);
            expect(cc.get("limits.common")).to.deep.equal({ number: 2, interval: 2000 });
        });

        // Билдер собирает новые объекты на каждой сборке, поэтому сравнение поддеревьев по
        // ссылке сообщало бы об изменении на каждой пересборке.
        it("keeps silent when the rebuilt values repeat the previous ones", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            let calls = 0;

            cc.onChange("limits", () => {
                calls += 1;
            });
            cc.onChange("tempDir", () => {
                calls += 1;
            });

            await signalled(storage);

            expect(calls).to.equal(0);
        });

        it("keeps silent for the paths nobody subscribed to", async () => {
            const { cc, storage } = await watched({ NUMBER: "1" });
            let calls = 0;

            cc.onChange("tempDir", () => {
                calls += 1;
            });

            storage.raw = { NUMBER: "2" };
            await signalled(storage);

            expect(calls).to.equal(0);
            expect(cc.get("limits.common.number")).to.equal(2);
        });

        // Отписка последнего слушателя пути не закрывает путь: подписка на него обязана работать
        // как первая.
        it("accepts a new listener on a path whose last listener has unsubscribed", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const calls: string[] = [];

            cc.onChange("tempDir", () => {
                calls.push("first");
            })();

            cc.onChange("tempDir", () => {
                calls.push("second");
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(calls).to.deep.equal(["second"]);
        });

        it("stops calling a listener that has unsubscribed and keeps the rest of the path", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const calls: string[] = [];

            const unsubscribe = cc.onChange("tempDir", () => {
                calls.push("first");
            });
            cc.onChange("tempDir", () => {
                calls.push("second");
            });

            unsubscribe();

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(calls).to.deep.equal(["second"]);
        });

        // Необязательное поддерево, ставшее null, — изменение самого пути, а не его листьев:
        // обходить null нечем, и слушателю отдаётся то, что теперь лежит по его пути.
        it("reports a subtree that became null as a change of its own path", async () => {
            const values: Values[] = [
                { tempDir: "/data", limits: { common: { number: 1, interval: 1000 } } },
                { tempDir: "/data", limits: null as unknown as Values["limits"] },
            ];
            const sequence: ConfigBuilder<Values> = {
                build: (): Values => values.shift() ?? { tempDir: "/data", limits: null as unknown as Values["limits"] },
            };
            const { cc, storage } = await watched({}, sequence);
            const calls: Array<[unknown, unknown]> = [];
            let insideCalls = 0;

            cc.onChange("limits", (newValue, oldValue) => {
                calls.push([newValue, oldValue]);
            });
            cc.onChange("limits.common.number", () => {
                insideCalls += 1;
            });

            await signalled(storage);

            expect(calls).to.deep.equal([[null, { common: { number: 1, interval: 1000 } }]]);
            expect(insideCalls).to.equal(0);
        });

        it("keeps the previous values and reports the failure when the build fails", async () => {
            const failing: ConfigBuilder<Values> = {
                build: (raw): Values => {
                    if (raw["TEMP_DIR"] === "/broken") {
                        throw new InvalidConfigError('Invalid config "tempDir"');
                    }

                    return fromRaw.build(raw);
                },
            };
            const { cc, storage } = await watched({ TEMP_DIR: "/data" }, failing);
            const errors: unknown[] = [];

            cc.onError((error) => {
                errors.push(error);
            });

            storage.raw = { TEMP_DIR: "/broken" };
            await signalled(storage);

            expect(errors).to.have.lengthOf(1);
            expect(errors[0]).to.be.instanceOf(InvalidConfigError);
            expect(cc.get("tempDir")).to.equal("/data");
        });

        it("stops reporting to an error listener that has unsubscribed", async () => {
            const failing: ConfigBuilder<Values> = {
                build: (raw): Values => {
                    if (raw["TEMP_DIR"] === "/broken") {
                        throw new InvalidConfigError("the config is broken");
                    }

                    return fromRaw.build(raw);
                },
            };
            const { cc, storage } = await watched({ TEMP_DIR: "/data" }, failing);
            const errors: unknown[] = [];

            const unsubscribe = cc.onError((error) => {
                errors.push(error);
            });

            unsubscribe();

            storage.raw = { TEMP_DIR: "/broken" };
            await signalled(storage);

            expect(errors).to.have.lengthOf(0);
            expect(cc.get("tempDir")).to.equal("/data");
        });

        it("reads the source once per signal", async () => {
            const { storage } = await watched();
            const loadsAfterInit = storage.loads;

            await signalled(storage);

            expect(storage.loads - loadsAfterInit).to.equal(1);
        });

        // Пересборки не идут параллельно: они гонялись бы за одно поле значений, и порядок
        // событий решала бы гонка. Сигналы, пришедшие во время пересборки, сливаются в один
        // проход — снимок читается целиком и увидит последнее состояние источника.
        it("merges the signals that arrive during a rebuild into one extra pass", async () => {
            const { storage } = await watched();
            const loadsAfterInit = storage.loads;
            const release = storage.holdLoads();

            storage.signal();
            storage.signal();
            storage.signal();

            release();
            await waitFor(() => storage.loads - loadsAfterInit === 2);
            await sleep(0);

            expect(storage.loads - loadsAfterInit).to.equal(2);
        });
    });

    describe("listeners", () => {
        it("reports a listener that threw and still calls the rest", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const failure = new Error("listener is broken");
            const errors: unknown[] = [];
            let calls = 0;

            cc.onError((error) => {
                errors.push(error);
            });
            cc.onChange("tempDir", () => {
                throw failure;
            });
            cc.onChange("tempDir", () => {
                calls += 1;
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(errors).to.deep.equal([failure]);
            expect(calls).to.equal(1);
        });

        // Слушатель объявлен возвращающим void, но асинхронную функцию компилятор в такой тип
        // пропускает: без catch её отказ дошёл бы до unhandledRejection и погасил процесс.
        it("reports the rejection of an asynchronous listener", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const failure = new Error("listener is broken");
            const errors: unknown[] = [];

            cc.onError((error) => {
                errors.push(error);
            });
            cc.onChange("tempDir", async (): Promise<void> => {
                await sleep(1);

                throw failure;
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);
            await waitFor(() => errors.length > 0);

            expect(errors).to.deep.equal([failure]);
        });

        // Отказ самого канала ошибок глушится: отправить его туда же значит уйти в рекурсию,
        // а бросить наружу — оборвать рассылку остальным.
        it("swallows an error thrown by an error listener and reports to the rest", async () => {
            const failing: ConfigBuilder<Values> = {
                build: (raw): Values => {
                    if (raw["TEMP_DIR"] === "/broken") {
                        throw new InvalidConfigError("the config is broken");
                    }

                    return fromRaw.build(raw);
                },
            };
            const { cc, storage } = await watched({ TEMP_DIR: "/data" }, failing);
            const errors: unknown[] = [];

            cc.onError(() => {
                throw new Error("error listener is broken");
            });
            cc.onError((error) => {
                errors.push(error);
            });

            storage.raw = { TEMP_DIR: "/broken" };
            await signalled(storage);

            expect(errors).to.have.lengthOf(1);
            expect(errors[0]).to.be.instanceOf(InvalidConfigError);
        });

        // Слушатель вправе подписаться прямо в вызове: обход живого набора позвал бы
        // добавленного на том же изменении.
        it("does not call a listener that appeared during the same notification", async () => {
            const { cc, storage } = await watched({ TEMP_DIR: "/data" });
            const calls: string[] = [];

            cc.onChange("tempDir", () => {
                calls.push("first");

                cc.onChange("tempDir", () => {
                    calls.push("second");
                });
            });

            storage.raw = { TEMP_DIR: "/data/next" };
            await signalled(storage);

            expect(calls).to.deep.equal(["first"]);

            storage.raw = { TEMP_DIR: "/data/third" };
            await signalled(storage);

            expect(calls).to.deep.equal(["first", "first", "second"]);
        });
    });
});
