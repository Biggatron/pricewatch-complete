// Utility function to handle responses and errors
async function handleResponse(response) {
  const contentType = response.headers.get('Content-Type');
  
  if (!response.ok) {
    // Handle different types of errors
    const errorText = contentType && contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    const error = new Error(errorText || response.statusText);
    error.status = response.status;
    throw error;
  }

  // If the response is redirected, handle redirection
  if (response.redirected) {
    window.location.href = response.url;
    return response;
  }

  // Return the JSON response if available
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  }

  // Return the response text if JSON is not available
  return await response.text();
}

async function handleError(error) {
  let errorString = error.message;
  
  try {
    let json = JSON.parse(error.message);
    if(json.message) {
      errorString = json.message;
    }
  } catch ( parseOrAccessError ) {};
  
  return errorString;
}

async function postData(url = '', data = {}) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-cache',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(data),
    });

    return await handleResponse(response);
  } catch (error) {
    console.error('POST request failed:', error);
    throw await handleError(error);
  }
}

async function putData(url = '', data = {}) {
  try {
    const response = await fetch(url, {
      method: 'PUT',
      mode: 'cors',
      cache: 'no-cache',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify(data),
    });

    return await handleResponse(response);
  } catch (error) {
    console.error('PUT request failed:', error);
    throw error;
  }
}

async function getData(url = '') {
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
    });

    return await handleResponse(response);
  } catch (error) {
    console.error('GET request failed:', error);
    throw error;
  }
}

async function deleteData(url = '') {
  try {
    const response = await fetch(url, {
      method: 'DELETE',
      mode: 'cors',
      cache: 'no-cache',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
    });

    return await handleResponse(response);
  } catch (error) {
    console.error('DELETE request failed:', error);
    throw error;
  }
}