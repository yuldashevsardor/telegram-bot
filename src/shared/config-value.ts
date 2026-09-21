// The configuration is taken from ApplicationContext and not from the DI container: it exists
// before the container, so there is no point asking the container for it. That also removes the
// import cycle the former @ConfigValue held, going for it to the module singleton container.
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
// Types only: the import is erased at build time.
import type { ConfigPath, ConfigValue } from "app/bootstrap/config/container/config-container.types";

// A configuration value by its dotted path; put as the default of a constructor parameter. Why a
// function and not a decorator, and what that rests on — docs/architecture/application.md, the
// "DI" section.
function configValue<Path extends ConfigPath>(path: Path): ConfigValue<Path> {
    return ApplicationContext.getConfigContainer().get(path);
}

export { configValue };
