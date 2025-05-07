const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { VM } = require('vm2');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

/**
 * Find eval-packed JavaScript in HTML content
 * @param {string} htmlContent - HTML content to search for packed scripts
 * @returns {string[]} - Array of packed scripts found
 */
function findEvalPackedJs(htmlContent) {
    const pattern = /eval\(function\(p,a,c,k,e,d\)\{.*?\}\(.*?\)\)/gs;
    const matches = htmlContent.match(pattern) || [];
    
    // Additional pattern to catch variations of packed scripts
    const altPattern = /\(function\(.*?\)\{.*?\}\)\(.*?\)/gs;
    const altMatches = htmlContent.match(altPattern) || [];
    
    return [...matches, ...altMatches].filter(script => script.length > 100);
}

/**
 * Unpacks a packed JavaScript string
 * @param {string} packedJs - Packed JavaScript to unpack
 * @returns {string|null} - Unpacked JavaScript or null if unpacking fails
 */
function unpackPackedScript(packedJs) {
    try {
        // Create a sandbox with comprehensive environment
        const vm = new VM({
            timeout: 5000,
            sandbox: {
                result: null,
                window: {
                    document: {},
                    navigator: {},
                    location: {}
                },
                document: {},
                navigator: {},
                location: {},
                // Add common functions that might be referenced
                String: String,
                Array: Array,
                Object: Object,
                Math: Math,
                Date: Date,
                JSON: JSON,
                console: console,
                setTimeout: setTimeout,
                setInterval: setInterval,
                clearTimeout: clearTimeout,
                clearInterval: clearInterval
            }
        });

        // Robust unpacker that handles different packing formats
        const unpacker = `
            function unpack(packed) {
                var env = {
                    eval: function(c) { 
                        try {
                            result = c; 
                            if(typeof result === 'function') {
                                result = result.toString();
                            }
                        } catch(e) {
                            result = "Error in eval: " + e.message;
                        }
                    },
                    window: {},
                    document: {},
                    console: {
                        log: function() {},
                        error: function() {}
                    }
                };
                
                var result;
                try {
                    with(env) { 
                        eval(packed); 
                    }
                } catch(e) {
                    result = "Error in unpacking: " + e.message;
                }
                
                if(typeof result === 'string' && result.includes('Error')) {
                    // Try alternative unpacking method
                    try {
                        var fn = new Function('return ' + packed);
                        result = fn().toString();
                    } catch(e2) {
                        result = "Alternative unpacking failed: " + e2.message;
                    }
                }
                
                return result;
            }
            result = unpack(${JSON.stringify(packedJs)});
        `;

        vm.run(unpacker);
        return vm.sandbox.result;
    } catch (error) {
        console.error('Error in VM:', error);
        
        // Fallback to simple regex unpacking if VM fails
        try {
            // This handles common packed patterns
            const unpacked = packedJs.replace(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\(.*?\)\)/, '')
                                    .replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => 
                                        String.fromCharCode(parseInt(hex, 16)));
            return unpacked;
        } catch (fallbackError) {
            console.error('Fallback unpacking failed:', fallbackError);
            return null;
        }
    }
}

/**
 * API endpoint to get full packed scripts
 */
app.get('/packed/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const { index } = req.query;
        
        if (!slug) {
            return res.status(400).json({
                success: false,
                error: "Slug parameter is required"
            });
        }
        
        try {
            // Fetch HTML content with proper error handling
            const url = `https://zpjid.com/bkg/${slug}?ref=animedub.pro`;
            const response = await axios.get(url, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Referer': 'https://animedub.pro/'
                }
            });
            
            // Find eval-packed JavaScript with improved regex
            const packedScripts = findEvalPackedJs(response.data);
            
            if (!packedScripts || packedScripts.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: "No eval-packed scripts found for this slug",
                    debug: {
                        responseLength: response.data.length,
                        sample: response.data.substring(0, 500) + "..."
                    }
                });
            }
            
            // If index is specified, return that specific script
            if (index !== undefined) {
                const scriptIndex = parseInt(index, 10);
                if (isNaN(scriptIndex)) {
                    return res.status(400).json({
                        success: false,
                        error: "Index must be a number"
                    });
                }
                
                if (scriptIndex < 0 || scriptIndex >= packedScripts.length) {
                    return res.status(400).json({
                        success: false,
                        error: `Invalid index: ${index}. Available range: 0-${packedScripts.length - 1}`
                    });
                }
                
                return res.json({
                    success: true,
                    slug,
                    script_index: scriptIndex,
                    total_scripts: packedScripts.length,
                    packed_js: packedScripts[scriptIndex],
                    script_length: packedScripts[scriptIndex].length
                });
            }
            
            // Return all packed scripts if no index specified
            return res.json({
                success: true,
                slug,
                total_scripts: packedScripts.length,
                packed_scripts: packedScripts.map(script => ({
                    content: script,
                    length: script.length
                })),
                debug: {
                    first_script_sample: packedScripts[0].substring(0, 200) + "...",
                    last_script_sample: packedScripts[packedScripts.length - 1].substring(0, 200) + "..."
                }
            });
            
        } catch (error) {
            console.error(`Error fetching packed scripts: ${error.message}`);
            return res.status(500).json({
                success: false,
                error: `Error fetching packed scripts: ${error.message}`,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    } catch (error) {
        console.error(`Error in packed endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * API endpoint to unpack packed scripts
 */
app.get('/unpack/:slug', async (req, res) => {
    try {
        const { slug } = req.params;
        const { index } = req.query;
        
        if (!slug) {
            return res.status(400).json({
                success: false,
                error: "Slug parameter is required"
            });
        }
        
        try {
            // First get the packed scripts
            const packedResponse = await axios.get(`http://localhost:${PORT}/packed/${slug}`);
            
            if (!packedResponse.data.success) {
                return res.status(404).json({
                    success: false,
                    error: "Could not get packed scripts",
                    details: packedResponse.data
                });
            }
            
            const packedScripts = packedResponse.data.packed_scripts || 
                                 [packedResponse.data.packed_js];
            
            // If index is specified, unpack that specific script
            if (index !== undefined) {
                const scriptIndex = parseInt(index, 10);
                if (isNaN(scriptIndex)) {
                    return res.status(400).json({
                        success: false,
                        error: "Index must be a number"
                    });
                }
                
                if (scriptIndex < 0 || scriptIndex >= packedScripts.length) {
                    return res.status(400).json({
                        success: false,
                        error: `Invalid index: ${index}. Available range: 0-${packedScripts.length - 1}`
                    });
                }
                
                const scriptContent = packedScripts[scriptIndex].content || packedScripts[scriptIndex];
                const unpackedJs = unpackPackedScript(scriptContent);
                
                if (!unpackedJs) {
                    return res.status(500).json({
                        success: false,
                        error: `Failed to unpack script at index ${scriptIndex}`
                    });
                }
                
                return res.json({
                    success: true,
                    slug,
                    script_index: scriptIndex,
                    total_scripts: packedScripts.length,
                    unpacked_js: unpackedJs,
                    unpacked_length: unpackedJs.length
                });
            }
            
            // Unpack all scripts if no index specified
            const results = [];
            for (let i = 0; i < packedScripts.length; i++) {
                const scriptContent = packedScripts[i].content || packedScripts[i];
                const unpackedJs = unpackPackedScript(scriptContent);
                
                if (unpackedJs) {
                    results.push({
                        script_index: i,
                        unpacked_js: unpackedJs,
                        unpacked_length: unpackedJs.length,
                        status: "success"
                    });
                } else {
                    results.push({
                        script_index: i,
                        error: "Failed to unpack script",
                        status: "failed"
                    });
                }
            }
            
            return res.json({
                success: true,
                slug,
                total_scripts: packedScripts.length,
                results,
                stats: {
                    success_count: results.filter(r => r.status === "success").length,
                    failed_count: results.filter(r => r.status === "failed").length
                }
            });
            
        } catch (error) {
            console.error(`Error unpacking scripts: ${error.message}`);
            return res.status(500).json({
                success: false,
                error: `Error unpacking scripts: ${error.message}`,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    } catch (error) {
        console.error(`Error in unpack endpoint: ${error}`);
        res.status(500).json({
            success: false,
            error: `Server error: ${error.message}`,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

/**
 * Error handling middleware
 */
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`M3U8 Extractor API running on port ${PORT}`);
    console.log(`Try these endpoints:
    - http://localhost:${PORT}/packed/9q4yh8ji5k4w
    - http://localhost:${PORT}/unpack/9q4yh8ji5k4w`);
});

module.exports = app;
