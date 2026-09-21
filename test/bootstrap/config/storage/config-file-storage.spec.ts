import { expect } from "chai";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ConfigFileStorage } from "app/bootstrap/config/storage/file/config-file-storage";
import { ConfigFileUnreadable } from "app/bootstrap/config/storage/file/config-file-storage.errors";
import type { ConfigStorage } from "app/bootstrap/config/storage/config-storage";
import type { RawConfig } from "app/bootstrap/config/container/config-container.types";

// Интервал опроса в спеке — десятки миллисекунд: настоящий (2000) растянул бы прогон на минуты, а
// на единицах обессмыслились бы проверки «сигнала не было»: их окна заданы интервалом
// (`sleep(INTERVAL * 4)` и `sleep(INTERVAL * 6)`) и свелись бы к единицам миллисекунд. Запаса на
// попадание опроса в такое окно не остаётся, и прошедшая проверка уже не значила бы, что опрос
// в нём был.
const INTERVAL = 25;

function base(raw: RawConfig): ConfigStorage {
    return { load: async (): Promise<RawConfig> => raw };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ждёт число сигналов, а не предикат по нему: счётчик сигналов только растёт, поэтому перебор
// делает строгое равенство ложным навсегда, и ожидание доходит до дедлайна — того же, каким
// кончается недостача. Сообщение про несостоявшийся сигнал обвиняло бы тогда наблюдателя в
// пропаже, хотя сигналов было больше, чем ждали, и искать пошли бы не туда. Сравнение на дедлайне
// печатает фактическое число рядом с ожидаемым и называет любой из двух случаев.
async function waitForSignals(signals: () => number, expected: number, timeout = 1000): Promise<void> {
    const deadline = Date.now() + timeout;

    while (signals() !== expected) {
        if (Date.now() > deadline) {
            expect(signals()).to.equal(expected, "the storage did not report the changes in time");
        }

        await sleep(1);
    }
}

describe("ConfigFileStorage", () => {
    let directory: string;
    let filePath: string;
    let storages: ConfigFileStorage[];

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "config-file-storage-"));
        filePath = path.join(directory, "runtime.env");
        storages = [];
    });

    // Оставленный опрос держал бы событийный цикл: у mocha нет --exit, и прогон дождался бы
    // своего таймаута вместо завершения.
    afterEach(async () => {
        for (const storage of storages) {
            storage.unwatch();
        }

        await fs.rm(directory, { recursive: true, force: true });
    });

    function storage(interval = INTERVAL, raw: RawConfig = {}): ConfigFileStorage {
        const created = new ConfigFileStorage(base(raw), filePath, interval);

        storages.push(created);

        return created;
    }

    // Правка под наблюдением идёт одной записью на месте: fs.writeFile с флагом по умолчанию
    // сначала обрезает файл (O_TRUNC) и только потом пишет содержимое, и опрос, попавший между
    // обрезкой и записью, видит два изменения вместо одного — одна правка дала бы два сигнала.
    // Флаг r+ не обрезает, отсюда две проверки перед записью. Содержимое не короче прежнего:
    // остаток файла запись не убирает, и хвост прежнего значения остался бы в файле. И непустое:
    // на пустом файле проверку размера пустое прошло бы, а запись нулевой длины не меняет ни
    // размера, ни времени — правка ушла бы без сигнала, и виноватым выглядел бы наблюдатель.
    // Проверки стоят здесь же: сам stat времён файла не меняет и сигнала не даёт, в отличие от
    // обрезки.
    async function change(contents: string): Promise<void> {
        const length = Buffer.byteLength(contents);

        expect(length).to.be.greaterThan(0);
        expect(length).to.be.at.least((await fs.stat(filePath)).size);

        await fs.writeFile(filePath, contents, { flag: "r+" });
    }

    // Подмена файла целиком — готовое содержимое переименованием поверх пути: одним шагом и с
    // новым inode, который нужен спеке про подмену файла. Так же файл и появляется: fs.writeFile
    // создал бы его пустым и наполнил вторым шагом, а это для наблюдателя снова два изменения.
    async function replace(contents: string): Promise<void> {
        const temporary = `${filePath}.tmp`;

        await fs.writeFile(temporary, contents);
        await fs.rename(temporary, filePath);
    }

    // Файл лежит под базовым источником: заданное там перекрывает его, а сам файл добавляет
    // значения ключам, которых в базовом источнике нет.
    it("lets the base source win over the file", async () => {
        await fs.writeFile(filePath, "FROM_FILE=file\nSHARED=file\n");

        const raw = await storage(INTERVAL, { FROM_BASE: "base", SHARED: "base" }).load();

        expect(raw["FROM_BASE"]).to.equal("base");
        expect(raw["FROM_FILE"]).to.equal("file");
        expect(raw["SHARED"]).to.equal("base");
    });

    // Пустая переменная базового источника — «не задано», а не «задано пустым»: половина
    // переменных в .env объявлена пустыми, и перекрывай они файл, менять их на ходу было бы
    // нельзя. Пробелы в кавычках dotenv сохраняет (незакавыченные он обрезает сам), а
    // ConfigParser всё равно считает их пустотой.
    it("lets the file value through for a key the base source leaves blank", async () => {
        await fs.writeFile(filePath, "BLANK=file\nPADDED=file\nMISSING=file\n");

        // undefined базовый источник вправе отдать: снимок объявлен как Record<string, string |
        // undefined>, и обращаться с ним как со строкой нельзя.
        const raw = await storage(INTERVAL, { BLANK: "", PADDED: "   ", MISSING: undefined }).load();

        expect(raw["BLANK"]).to.equal("file");
        expect(raw["PADDED"]).to.equal("file");
        expect(raw["MISSING"]).to.equal("file");
    });

    // Отсутствие файла — нормальное состояние: наблюдение начинается до его появления, а
    // удаление возвращает значения базовому источнику.
    it("falls back to the base source when there is no file", async () => {
        const raw = await storage(INTERVAL, { FROM_BASE: "base" }).load();

        expect(raw).to.deep.equal({ FROM_BASE: "base" });
    });

    // Пустой набор вместо отказа снял бы разом все значения файла, и причина осталась бы
    // неизвестной.
    it("throws ConfigFileUnreadable when the path cannot be read", async () => {
        // Каталог на месте файла: его чтение падает не ENOENT, а EISDIR.
        await fs.mkdir(filePath);

        const failed = await storage()
            .load()
            .then(
                () => expect.fail("load() was expected to reject"),
                (reason: unknown) => reason,
            );

        expect(failed).to.be.instanceOf(ConfigFileUnreadable);
        expect(failed).to.have.property("message", `Config file "${filePath}" is unreadable`);
        expect(failed).to.have.property("payload").that.deep.equals({ path: filePath });
        expect(failed).to.have.property("cause").that.has.property("code", "EISDIR");
    });

    it("reports the appearance, the change and the removal of the file", async () => {
        const watchable = storage();
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });

        // Слушатель на отсутствующем файле зовётся сразу после подписки, с нулями в обоих
        // снимках: этот вызов изменением не считается.
        await sleep(INTERVAL * 4);
        expect(signals).to.equal(0);

        await replace("A=1\n");
        await waitForSignals(() => signals, 1);

        // Та же длина: изменение видно по времени правки, а не по размеру. Размер проверяется
        // после записи, потому что страховка change() — «не короче»: удлинённый при доработке
        // литерал прошёл бы её молча, уехав на проверку по размеру и оставив эту строку ложью.
        await change("A=2\n");
        expect((await fs.stat(filePath)).size).to.equal(Buffer.byteLength("A=1\n"));
        await waitForSignals(() => signals, 2);

        expect((await watchable.load())["A"]).to.equal("2");

        await fs.rm(filePath);
        await waitForSignals(() => signals, 3);

        expect(await watchable.load()).to.deep.equal({});
    });

    // Редактор сохраняет файл записью во временный и переименованием поверх: inode меняется, и
    // подписка на события файловой системы потеряла бы файл вместе с ним.
    it("keeps reporting after the file has been replaced with another inode", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watchable = storage();
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });

        // Базовое состояние наблюдатель снимает уже после подписки: правка, обогнавшая первый
        // опрос, попала бы в это состояние и изменением не считалась бы.
        await sleep(INTERVAL * 4);

        await replace("A=2\n");
        await waitForSignals(() => signals, 1);

        await change("A=3\n");
        await waitForSignals(() => signals, 2);

        expect((await watchable.load())["A"]).to.equal("3");
    });

    // Правка, сохранившая время изменения (архиватор, rsync --times), видна по размеру: иначе
    // такой файл остался бы непрочитанным до следующей обычной правки. Время выставляется обоим
    // состояниям файла явно: естественное время правки идёт с наносекундами, а возвращённое
    // через Date округляется до миллисекунд, и сравнение времени отличило бы их само. Интервал
    // секундный намеренно: запись и возврат времени должны попасть в один опрос, иначе опрос
    // между ними увидел бы новое время, и проверялось бы не то.
    it("reports a change that kept the modification time", async function () {
        this.timeout(6000);

        const time = new Date(1700000000000);

        await fs.writeFile(filePath, "A=1\n");
        await fs.utimes(filePath, time, time);

        const watchable = storage(1000);
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });

        await change("A=1234567890\n");
        await fs.utimes(filePath, time, time);
        await waitForSignals(() => signals, 1, 4000);

        expect((await watchable.load())["A"]).to.equal("1234567890");
    });

    // Снятое наблюдение заводится заново: иначе выключить его на время и вернуть было бы нечем.
    it("watches again after unwatch()", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watchable = storage();
        let signals = 0;

        watchable.unwatch();
        watchable.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);
        await change("A=2\n");
        await waitForSignals(() => signals, 1);

        watchable.unwatch();
        watchable.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);
        await change("A=3\n");
        await waitForSignals(() => signals, 2);
    });

    it("stops reporting after unwatch()", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watchable = storage();
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);
        watchable.unwatch();

        await change("A=2\n");
        await sleep(INTERVAL * 6);

        expect(signals).to.equal(0);
    });

    // Второй watch() поверх первого завёл бы второй опрос того же пути, а unwatch() снял бы оба
    // сразу: слушатель молча перестал бы получать сигналы.
    it("keeps a single watch when watch() is called twice", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watchable = storage();
        let signals = 0;

        watchable.watch(() => {
            signals += 1;
        });
        watchable.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);
        await change("A=2\n");
        await waitForSignals(() => signals, 1);
        await sleep(INTERVAL * 4);

        expect(signals).to.equal(1);
    });

    // unwatch() без watch() — обычный путь остановки приложения, которое не успело дойти до
    // наблюдения. Своего слушателя у источника при этом нет, и снимать с пути чужих он не вправе:
    // unwatchFile без слушателя убирает всех, кто следит за этим путём.
    it("does nothing on unwatch() without watch()", async () => {
        await fs.writeFile(filePath, "A=1\n");

        const watching = storage();
        const idle = storage();
        let signals = 0;

        watching.watch(() => {
            signals += 1;
        });

        await sleep(INTERVAL * 4);

        expect(() => idle.unwatch()).to.not.throw();

        await change("A=2\n");
        await waitForSignals(() => signals, 1);
    });
});
