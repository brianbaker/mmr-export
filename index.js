'use strict';

const fs = require('fs'),
	http = require('http'),
	path = require('path'),
	Promise = require('bluebird');

const DESTINATION = path.join(__dirname, 'export'),
	CONCURRENCY_FOR_MONTHLY_WORKOUTS = 6,
	CONCURRENCY_FOR_TCX_EXPORT = 10,
	CONCURRENCY_FOR_TCX_WRITING = 20,
	MMR_SESSION_ID = '';

let options = {
	'method': 'GET',
	'hostname': 'www.mapmyrun.com',
	'headers': {
		'Cookie': `mmfsessid=${MMR_SESSION_ID}`
	}
};


/**
 * Uses a JSON API to request the workouts for an entire month.
 * @param {Date} date Date object representing the month.
 * @returns {Promise}
 */
function requestWorkoutsForMonth(date) {

	return new Promise((resolve, reject) => {
		let workoutMonth = new Date(date);

		options.path = `/workouts/dashboard.json?month=${date.getMonth() + 1}&year=${date.getFullYear()}`;

		let req = http.request(options, res => {
			//console.log(`STATUS: ${res.statusCode}`);
			//console.log(`HEADERS: ${JSON.stringify(res.headers)}`);

			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => {
				let workoutData = JSON.parse(data);
				if (workoutData && workoutData.workout_data && Object.keys(workoutData.workout_data.workouts || {}).length) {
					let monthData = [];

					Object.keys(workoutData.workout_data.workouts).forEach(w => {
						monthData = monthData.concat(workoutData.workout_data.workouts[w]);
					});

					console.log(`${monthData.length} workouts found in ${workoutMonth.toDateString()}`);
					resolve(monthData);
				} else {
					reject(new Error(`Workout data not found for ${workoutMonth.toDateString()}`));
				}
			});
		});
		req.on('error', e => reject(e));
		req.end();
	});
}

/**
 * For a given workout id, request the TCX export.
 * @param {String} date The date of the MMR workout.
 * @param {String} id A MMR workout ID.
 * @returns {Promise}
 */
function requestWorkoutTcx(date, id) {
	return new Promise((resolve, reject) => {
		let workoutDate = date,
			workoutId = id;

		options.path = `/workout/export/${id}/tcx`;

		let req = http.request(options, res => {
			let data = '';
			res.on('data', chunk => data += chunk);
			res.on('end', () => resolve({id: workoutId, date: workoutDate, data: data}));
		});
		req.on('error', e => reject(e));
		req.end();
	});
}


let now = new Date(),
	months = [];

// 2005-01-01 is the first available date on MMR
for (let d = new Date(2005, 0, 1); d < now; d.setMonth(d.getMonth() + 1)) {
	months.push(new Date(d));
}

// retrieve workouts for 6 months at a time until complete
Promise.map(months, m => {

	console.log(`REQUESTING: ${m.toDateString()}`);

	return requestWorkoutsForMonth(m).catch(e => e);

}, { concurrency: CONCURRENCY_FOR_MONTHLY_WORKOUTS }).then(results => {

	let tcxDownloads = [];

	console.log(`${results.length} months of data found, requesting TCX files...`);

	// we end up with an array of arrays (months => workouts) and must ignore errors
	results.filter(month => !(month instanceof Error)).forEach(month => {
		month.forEach(workout => {
			let url = String(workout.view_url);
			let matches = url.match(/\/workout\/(\d+)$/) || [];
			if (matches.length < 2) {
				console.error(`ERROR FINDING WORKOUT ID: ${w}, URL: ${url}, DEBUG: ${workout}`);
			} else {
				tcxDownloads.push({ date: workout.date.replace(/\//g,'-'), id: matches[1] });
			}
		});
	});

	// display the errors
	results.filter(month => month instanceof Error).forEach(month => {
		console.error(month);
	});

	console.log(`${tcxDownloads.length} TCX downloads to be requested...`);

	return Promise.map(tcxDownloads, d => {
		return requestWorkoutTcx(d.date, d.id).catch(e => e);
	}, { concurrency: CONCURRENCY_FOR_TCX_EXPORT });

}).then(results => {

	return Promise.map(results, file => {
		if (file instanceof Error) {
			console.error(file.message);
		} else {
			return Promise.promisify(fs.writeFile)(path.join(DESTINATION, `${file.date}-${file.id}.tcx`), file.data);
		}
	}, { concurrency: CONCURRENCY_FOR_TCX_WRITING });

}).catch(e => {

	console.error(e);

});