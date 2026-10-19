import { readFile } from 'node:fs/promises'

// libheif's pure-JavaScript decoder needs static embind invokers in Workers.
// These focused source edits preserve its original type conversions and cleanup,
// avoid runtime string compilation, and distinguish Workers from Node's API shim.
// The dependency remains unmodified on disk; both bundlers use the same transform.
const replacements = [
  [
    "var ENVIRONMENT_IS_NODE=typeof process==\"object\"&&typeof process.versions==\"object\"&&typeof process.versions.node==\"string\";var scriptDirectory=\"\";function locateFile(path){if(Module[\"locateFile\"]){return Module[\"locateFile\"](path,scriptDirectory)}return scriptDirectory+path}var read_,readAsync,readBinary;if(ENVIRONMENT_IS_NODE){var fs=require(\"fs\");var nodePath=require(\"path\");if(ENVIRONMENT_IS",
    "var ENVIRONMENT_IS_NODE=!(typeof navigator==\"object\"&&navigator.userAgent==\"Cloudflare-Workers\")&&typeof process==\"object\"&&typeof process.versions==\"object\"&&typeof process.versions.node==\"string\";var scriptDirectory=\"\";function locateFile(path){if(Module[\"locateFile\"]){return Module[\"locateFile\"](path,scriptDirectory)}return scriptDirectory+path}var read_,readAsync,readBinary;if(ENVIRONMENT_IS_NODE){var fs=require(\"node:fs\");var nodePath=require(\"node:path\");if(ENVIRONMENT_IS"
  ],
  [
    ",cppTargetFunc,isAsync){var argCount=argTypes.length;if(argCount<2){throwBindingError(\"argTypes array size mismatch! Must at least get return value and 'this' types!\")}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!==\"void\";var argsList=\"\";var argsListWired=\"\";for(var i=0;i<argCount-2;++i){argsList+=(i!==0?\", \":\"\")+\"arg\"+i;argsListWired+=(i!==0?\", \":\"\")+\"arg\"+i+\"Wired\"}var invokerFnBody=`\\n        return function ${makeLegalFunctionName(humanName)}(${argsList}) {\\n        if (arguments.length !== ${argCount-2}) {\\n          throwBindingError('function ${humanName} called with ' + arguments.length + ' arguments, expected ${argCount-2}');\\n        }`;if(needsDestructorStack){invokerFnBody+=\"var destructors = [];\\n\"}var dtorStack=needsDestructorStack?\"destructors\":\"null\";var args1=[\"throwBindingError\",\"invoker\",\"fn\",\"runDestructors\",\"retType\",\"classParam\"];var args2=[throwBindingError,cppInvokerFunc,cppTargetFunc,runDestructors,argTypes[0],argTypes[1]];if(isClassMethodFunc){invokerFnBody+=\"var thisWired = classParam.toWireType(\"+dtorStack+\", this);\\n\"}for(var i=0;i<argCount-2;++i){invokerFnBody+=\"var arg\"+i+\"Wired = argType\"+i+\".toWireType(\"+dtorStack+\", arg\"+i+\"); // \"+argTypes[i+2].name+\"\\n\";args1.push(\"argType\"+i);args2.push(argTypes[i+2])}if(isClassMethodFunc){argsListWired=\"thisWired\"+(argsListWired.length>0?\", \":\"\")+argsListWired}invokerFnBody+=(returns||isAsync?\"var rv = \":\"\")+\"invoker(fn\"+(argsListWired.length>0?\", \":\"\")+argsListWired+\");\\n\";if(needsDestructorStack){invokerFnBody+=\"runDestructors(destructors);\\n\"}else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var paramName=i===1?\"thisWired\":\"arg\"+(i-2)+\"Wired\";if(argTypes[i].destructorFunction!==null){invokerFnBody+=paramName+\"_dtor(\"+paramName+\"); // \"+argTypes[i].name+\"\\n\";args1.push(paramName+\"_dtor\");args2.push(argTypes[i].destructorFunction)}}}if(returns){invokerFnBody+=\"var ret = retType.fromWireType(rv);\\n\"+\"return ret;\\n\"}else{}invokerFnBody+=\"}\\n\";args1.push(invokerFnBody);return newFunc(Function,args1).apply(null,args2)}var heap32VectorToArray",
    ",cppTargetFunc,isAsync){\n  var count=argTypes.length;\n  if(count<2)throwBindingError(\"argTypes array size mismatch! Must at least get return value and 'this' types!\");\n  var method=argTypes[1]!==null&&classType!==null;\n  var needsStack=argTypes.some((type,i)=>i>0&&type!==null&&type.destructorFunction===undefined);\n  return createNamedFunction(humanName,function(){\n    if(arguments.length!==count-2)throwBindingError('function '+humanName+' called with '+arguments.length+' arguments, expected '+(count-2));\n    var destructors=needsStack?[]:null, wired=[], invoke=[cppTargetFunc];\n    if(method){wired[1]=argTypes[1].toWireType(destructors,this);invoke.push(wired[1]);}\n    for(var i=2;i<count;i++){wired[i]=argTypes[i].toWireType(destructors,arguments[i-2]);invoke.push(wired[i]);}\n    var result=cppInvokerFunc.apply(null,invoke);\n    if(needsStack)runDestructors(destructors);\n    else for(var i=method?1:2;i<count;i++)if(argTypes[i].destructorFunction!==null)argTypes[i].destructorFunction(wired[i]);\n    if(argTypes[0].name!==\"void\")return argTypes[0].fromWireType(result);\n  });\n}var heap32VectorToArray"
  ],
  [
    "r=(argCount,argTypes)=>{var types=emval_lookupTypes(argCount,argTypes);var retType=types.shift();argCount--;var params=[\"retType\"];var args=[retType];var argsList=\"\";for(var i=0;i<argCount;++i){argsList+=(i!==0?\", \":\"\")+\"arg\"+i;params.push(\"argType\"+i);args.push(types[i])}var signatureName=retType.name+\"_$\"+types.map(t=>t.name).join(\"_\")+\"$\";var functionName=makeLegalFunctionName(\"methodCaller_\"+signatureName);var functionBody=\"return function \"+functionName+\"(handle, name, destructors, args) {\\n\";var offset=0;for(var i=0;i<argCount;++i){functionBody+=\"    var arg\"+i+\" = argType\"+i+\".readValueFromPointer(args\"+(offset?\"+\"+offset:\"\")+\");\\n\";offset+=types[i][\"argPackAdvance\"]}functionBody+=\"    var rv = handle[name](\"+argsList+\");\\n\";for(var i=0;i<argCount;++i){if(types[i][\"deleteObject\"]){functionBody+=\"    argType\"+i+\".deleteObject(arg\"+i+\");\\n\"}}if(!retType.isVoid){functionBody+=\"    return retType.toWireType(destructors, rv);\\n\"}functionBody+=\"};\\n\";params.push(functionBody);var invokerFunction=newFunc(Function,params).apply(null,args);return emval_addMethodCaller(invokerFunction)};var __emval_incref=han",
    "r=(argCount,argTypes)=>{\n  var types=emval_lookupTypes(argCount,argTypes),retType=types.shift();\n  return emval_addMethodCaller(function(handle,name,destructors,args){\n    var values=[],offset=0;\n    for(var i=0;i<types.length;i++){values.push(types[i].readValueFromPointer(args+offset));offset+=types[i].argPackAdvance;}\n    var result=handle[name].apply(handle,values);\n    for(var i=0;i<types.length;i++)if(types[i].deleteObject)types[i].deleteObject(values[i]);\n    if(!retType.isVoid)return retType.toWireType(destructors,result);\n  });\n};var __emval_incref=han"
  ]
]

/** Refuse upstream source changes instead of silently shipping an unadapted decoder. */
export function transformHeif(source) {
  for (const [index, [before, after]] of replacements.entries()) {
    const start = source.indexOf(before)
    if (start < 0 || source.indexOf(before, start + 1) >= 0) {
      throw new Error(`HEIF Worker adaptation ${index + 1} no longer matches the dependency source; review the decoder before building`)
    }
    source = source.slice(0, start) + after + source.slice(start + before.length)
  }
  return source
}

const decoderFile = /[/\\]libheif-js[/\\]libheif[/\\]libheif\.js$/
const transformModule = (source, id) => decoderFile.test(id) ? { code: transformHeif(source), map: null } : null

export function heifEsbuildPlugin() {
  return {
    name: 'coaster-heif-worker',
    setup(build) {
      build.onLoad({ filter: decoderFile }, async ({ path }) => ({ contents: transformHeif(await readFile(path, 'utf8')), loader: 'js' }))
    },
  }
}

export function heifVitePlugin() {
  return {
    name: 'coaster-heif-worker',
    enforce: 'pre',
    // Vite's development dependency optimizer runs in each environment separately.
    configEnvironment() { return { optimizeDeps: { rolldownOptions: { plugins: [{ name: 'coaster-heif-worker-dependencies', transform: transformModule }] } } } },
    transform: transformModule,
  }
}
