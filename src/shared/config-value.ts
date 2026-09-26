// From ApplicationContext and not from the DI container (docs/architecture/application.md, "DI").
// That also removes the import cycle of the former @ConfigValue, which went to the module singleton
// container for the value.
import { ApplicationContext } from "app/bootstrap/application/context/application-context";
import type { ConfigPath, ConfigValue } from "app/bootstrap/config/container/config-container.types";

// A configuration value by its dotted path; put as the default of a constructor parameter. Why a
// function and not a decorator, and what that rests on — docs/architecture/application.md, the
// "DI" section.
function configValue<Path extends ConfigPath>(path: Path): ConfigValue<Path> {
    return ApplicationContext.getConfigContainer().get(path);
}

export { configValue };
