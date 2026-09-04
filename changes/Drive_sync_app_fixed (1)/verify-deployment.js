/**
 * Simple verification script to check if the Drive sync app is deployed correctly
 * Run with: node verify-deployment.js <your-deployed-url>
 */

const fetch = require('isomorphic-fetch');

if (process.argv.length < 3) {
  console.log('Usage: node verify-deployment.js <your-deployed-url>');
  console.log('Example: node verify-deployment.js https://drive-sync-app.onrender.com');
  process.exit(1);
}

const baseUrl = process.argv[2].replace(/\/+$/, ''); // Remove trailing slash

async function checkEndpoint(path, description) {
  try {
    const response = await fetch(`${baseUrl}${path}`);
    const data = await response.json();

    if (response.ok) {
      console.log(`✅ ${description}: OK`);
      return true;
    } else {
      console.log(`❌ ${description}: Failed (${response.status})`);
      console.log(`   Response:`, data);
      return false;
    }
  } catch (error) {
    console.log(`❌ ${description}: Error - ${error.message}`);
    return false;
  }
}

async function main() {
  console.log(`🔍 Verifying deployment at: ${baseUrl}\n`);

  let allPassed = true;

  // Check if server is running
  allPassed &= await checkEndpoint('/', 'Homepage');

  // Check auth status endpoint
  allPassed &= await checkEndpoint('/auth/status', 'Auth status endpoint');

  // Check if static assets are serving
  try {
    const response = await fetch(`${baseUrl}/style.css`);
    if (response.ok) {
      console.log('✅ Static assets (CSS): OK');
    } else {
      console.log(`❌ Static assets (CSS): Failed (${response.status})`);
      allPassed = false;
    }
  } catch (error) {
    console.log(`❌ Static assets (CSS): Error - ${error.message}`);
    allPassed = false;
  }

  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('🎉 All checks passed! Your app appears to be deployed correctly.');
    console.log(`🌐 Visit your app at: ${baseUrl}`);
    console.log('\nNext steps:');
    console.log('1. Connect your Google and Microsoft accounts');
    console.log('2. Browse and select files to sync');
    console.log('3. Click Sync and monitor progress');
  } else {
    console.log('⚠️  Some checks failed. Please review the errors above.');
    console.log('Common issues:');
    console.log('- Incorrect environment variables');
    console.log('- Missing API credentials');
    console.log('- Port configuration problems');
    console.log('- Redirect URI mismatches in Google/Azure consoles');
  }
  console.log('='.repeat(50));
}

main().catch(console.error);