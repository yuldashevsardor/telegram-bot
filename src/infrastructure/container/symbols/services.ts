export const Services = {
    FontConvertor: {
        FontConvertor: Symbol.for("FontConvertor"),
        ConvertorFactory: Symbol.for("ConvertorFactory"),
        FontForge: Symbol.for("FontForge"),
        FontSignatureMatcher: Symbol.for("FontSignatureMatcher"),
    },
    User: {
        UserService: Symbol.for("UserService"),
        UserRepository: Symbol.for("UserRepository"),
    },
};
