console.log("I am a worker o.o");
require("../")().addShutdownHandler(function(ctx,next){
    console.log("Worker now says baibai.");
    next();
});

process.exit(1);
