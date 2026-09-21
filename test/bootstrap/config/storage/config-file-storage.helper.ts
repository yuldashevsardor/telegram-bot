import { expect } from "chai";
import fs from "fs/promises";

// Правка файла под наблюдением ConfigFileStorage: одним шагом, иначе опрос успевает попасть
// внутрь неё. fs.writeFile с флагом по умолчанию сначала обрезает файл (O_TRUNC) и только потом
// пишет содержимое, и опрос, попавший между обрезкой и записью, видит два изменения вместо
// одного — правка дала бы лишний сигнал, а на нём и лишнюю пересборку значений по пустому файлу.
// Записи до начала наблюдения в помощниках не нуждаются.

// Запись на месте: флаг r+ не обрезает, отсюда две проверки перед записью. Содержимое не короче
// прежнего: остаток файла запись не убирает, и хвост прежнего значения остался бы в файле. И
// непустое: на пустом файле проверку размера пустое прошло бы, а запись нулевой длины не меняет
// ни размера, ни времени — правка ушла бы без сигнала, и виноватым выглядел бы наблюдатель.
// Проверки стоят здесь же: сам stat времён файла не меняет и сигнала не даёт, в отличие от
// обрезки.
export async function change(target: string, contents: string): Promise<void> {
    const length = Buffer.byteLength(contents);

    expect(length).to.be.greaterThan(0);
    expect(length).to.be.at.least((await fs.stat(target)).size);

    await fs.writeFile(target, contents, { flag: "r+" });
}

// Подмена файла целиком — готовое содержимое переименованием поверх пути: одним шагом и с новым
// inode, который нужен спеке про подмену файла. Так же файл и появляется: fs.writeFile создал бы
// его пустым и наполнил вторым шагом, а это для наблюдателя снова два изменения.
export async function replace(target: string, contents: string): Promise<void> {
    const temporary = `${target}.tmp`;

    await fs.writeFile(temporary, contents);
    await fs.rename(temporary, target);
}
