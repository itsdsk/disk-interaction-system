var keystone = require('keystone');
const ipc = require('node-ipc');

exports = module.exports = function (req, res) {

	var view = new keystone.View(req, res);
	var locals = res.locals;

	// Set locals
	locals.section = 'browse';
	locals.filters = {
		sketch: req.params.sketch,
	};
	locals.data = {
		sketches: [],
	};

	// Load the current sketch
	view.on('init', function (next) {

		// var startup = () => {
		// 	locals.ipfs.id(function (err, identity) {
		// 		if (err) {
		// 			console.log(err)
		// 			setTimeout(function(){ startup(); }, 5000);
		// 		} else {
		// 			console.log("Identity:")
		// 			console.log(identity)
		// 		}
		// 	})
		// }
		//startup()
		

		var q = keystone.list('Sketch').model.findOne({
			state: 'published',
			slug: locals.filters.sketch,
		}).populate('author categories');

		q.exec(function (err, result) {
			locals.data.sketch = result;
			next(err);
		});

	});

	// Load other sketches
	view.on('init', function (next) {

		var q = keystone.list('Sketch').model.find().where('state', 'published').sort('-publishedDate').populate('author').limit('4');

		q.exec(function (err, results) {
			locals.data.sketches = results;
			next(err);
		});

	});

	// Forward instruction to display selected sketch
	view.on('get', {
		display: 'on'
	}, function (next) {

		var sketchPath = locals.data.sketch.localPath;
		ipc.of.dplayeripc.emit('message', sketchPath);
		req.flash('success', 'Sketch queued for display.')
		return next();
	});

	// Render the view
	view.render('sketch');
};