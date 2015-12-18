var workerConf = JSON.parse(process.env.POWERHOUSE_CONFIG);
process.title = workerConf.title;

var PrettyError = require("pretty-error"),
    pe = new PrettyError(),
    house = require("./index")();

function loadAndRun(modulePath) {
    try {
        var m = require(modulePath);
        if(typeof m.run == "function") {
            m.run(workerConf, house);
        }
    } catch(e) {
        console.error(pe.render(e));
    }
}

// Load the init script
if(typeof workerConf.init != "undefined")
    loadAndRun(workerConf.init);

// Load the actual thing.
loadAndRun(workerConf.exec);

house.emit("worker.started");
