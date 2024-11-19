const query = require('../db/db');

function validateTimestamp(date) {
    if (date instanceof Date && !isNaN(date.getTime())) {
        // Date is valid in JavaScript, now we check if it falls within the PostgreSQL range.
        return date;
    }
    return null;
}

function replaceInvalidValues(obj) {
    // Check if the current object is actually an array
    if (Array.isArray(obj)) {
        // If it is, iterate over the array and recursively call the function on each element
        obj.forEach((item, index) => {
            obj[index] = replaceInvalidValues(item);
        });
    } else if (obj !== null && typeof obj === 'object') {
        // If it's an object (and not null), iterate over its properties
        Object.keys(obj).forEach(key => {
            // If the value is 'N/A' or '', set it to null
            if (obj[key] === 'N/A' || obj[key] === '') {
                obj[key] = null;
            } else if (typeof obj[key] === 'object') {
                // If the value is another object or array, recursively process it
                obj[key] = replaceInvalidValues(obj[key]);
            }
        });
    }
    // Return the modified object
    return obj;
}

module.exports = { 
    validateTimestamp : validateTimestamp,
    replaceInvalidValues : replaceInvalidValues
};