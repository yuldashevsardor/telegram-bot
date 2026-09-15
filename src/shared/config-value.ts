// Конфигурация берётся у ApplicationContext, а не из DI-контейнера: она существует до
// контейнера, поэтому спрашивать её у контейнера незачем. Так же снимается цикл импорта,
// который держал прежний @ConfigValue, ходивший за ней в модульный синглтон container.
import { ApplicationContext } from "app/bootstrap/application/application-context";
// Только типы: импорт стирается при сборке.
import type { ConfigPath, ConfigValue } from "app/bootstrap/config-container";

// Значение конфигурации по «точечному» пути; ставится умолчанием параметра конструктора.
// Почему функция, а не декоратор, и на чём это держится — docs/architecture/application.md,
// раздел «DI».
function configValue<Path extends ConfigPath>(path: Path): ConfigValue<Path> {
    return ApplicationContext.getConfigContainer().get(path);
}

export { configValue };
