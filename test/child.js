require("../")();
console.log("I am a child! O.O");
require("../")().addShutdownHandler(function(ctx,next){
    console.log("Child is in shutdown sequence...");
    next();
});
process.exit(1);
