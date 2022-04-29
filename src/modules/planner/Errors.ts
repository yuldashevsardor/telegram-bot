export class PlannerAlreadyCreatedError extends Error {
    constructor(message = "Planner already created.") {
        super(message);
    }
}
