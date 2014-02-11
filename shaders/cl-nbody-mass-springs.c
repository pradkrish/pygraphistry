// The fraction of tiles to process each execution of this kernel. For example, a value of '10' will
// cause an execution of this kernel to only process every 10th tile.
// The particular subset of tiles is chosen based off of stepNumber.
#define TILES_PER_ITERATION 7

// The energy with which points repulse each other
#define POINT_REPULSION -0.00001f
// The strength of the force pulling points toward the center of the graph
#define GRAVITY_FROM_CENTER 0.2f
// The energy with which the walls repulse points
// #define WALL_REPULSION  -0.0002f

// The length of the 'randValues' array
#define RAND_LENGTH 73 //146

// #define EDGE_REPULSION 0.5f

// #define SPRING_LENGTH 0.1f
// #define SPRING_FORCE 0.1f


// Calculate the force of point b on point a, returning a vector indicating the movement to point a
float2 calculatePointForce(float2 a, float2 b, float force, __constant float2* randValues, unsigned int randOffset);


__kernel void nbody_compute_repulsion(
	unsigned int numPoints,
	__global float2* inputPositions,
	__global float2* outputPositions,
	__local float2* tilePoints,
	float width,
	float height,
	__constant float2* randValues,
	unsigned int stepNumber)
{
    const float2 dimensions = (float2) (width, height);
	// use async_work_group_copy() and wait_group_events() to fetch the data from global to local
	// use vloadn() and vstoren() to read/write vectors.

	float alpha = 1.0f / clamp(((float) stepNumber)/2.0f, 1.0f, 30.0f);

	const unsigned int threadLocalId = (unsigned int) get_local_id(0);
	const unsigned int pointId = (unsigned int) get_global_id(0);

	// The point we're updating
	float2 myPos = inputPositions[pointId];

	// Points per tile = threads per workgroup
	const unsigned int tileSize = (unsigned int) get_local_size(0);
	const unsigned int numTiles = (unsigned int) get_num_groups(0);

	float2 posDelta = (float2) (0.0f, 0.0f);

    unsigned int modulus = numTiles / TILES_PER_ITERATION; // tiles per iteration:

	for(unsigned int tile = 0; tile < numTiles; tile++) {

	    if (tile % modulus != stepNumber % modulus) {
	    	continue;
	    }

		const unsigned int tileStart = (tile * tileSize);

		// If numPoints isn't a multiple of tileSize, the last tile will have less than the full
		// number of points. If we detect we'd be reading out-of-bounds data, clamp the number of
		// points we read to be within bounds.
		unsigned int thisTileSize =  tileStart + tileSize < numPoints ?
										tileSize : numPoints - tileStart;

		if(threadLocalId < thisTileSize){
			tilePoints[threadLocalId] = inputPositions[tileStart + threadLocalId];
		}

		barrier(CLK_LOCAL_MEM_FENCE);

		for(unsigned int j = 0; j < thisTileSize; j++) {
			unsigned int cachedPoint = j;
			// Don't calculate the forces of a point on itself
			if(tileStart + cachedPoint == pointId) {
				continue;
			}

			float2 otherPoint = tilePoints[cachedPoint];

			posDelta += calculatePointForce(myPos, otherPoint, POINT_REPULSION * alpha, randValues, stepNumber);
		}

		barrier(CLK_LOCAL_MEM_FENCE);
	}

	// Force of gravity pulling the points toward the center
	float2 center = dimensions / 2.0f;
	// TODO: Should we be dividing the stength of gravity by TILES_PER_ITERATION? We only consider
	// 1 / TILES_PER_ITERATION of the total points in any executuin, but here we apply full gravity.
	posDelta += ((float2) ((center.x - myPos.x), (center.y - myPos.y)) * (GRAVITY_FROM_CENTER * alpha));

	// Calculate force from walls
	// The force will come from a bit 'outside' the wall (to move points which are collected on the
	// wall.) This value controls how much outside.
	// float2 wallBuffer = dimensions / 100.0f;
	// // left wall
	// posDelta += calculatePointForce(myPos, (float2) (0.0f - wallBuffer.x, myPos.y), WALL_REPULSION * alpha, randValues, stepNumber);
	// // right wall
	// posDelta += calculatePointForce(myPos, (float2) (dimensions.x + wallBuffer.x, myPos.y), WALL_REPULSION * alpha, randValues, stepNumber);
	// // bottom wall
	// posDelta += calculatePointForce(myPos, (float2) (myPos.x, 0.0f - wallBuffer.y), WALL_REPULSION * alpha, randValues, stepNumber);
	// // top wall
	// posDelta += calculatePointForce(myPos, (float2) (myPos.x, dimensions.y + wallBuffer.y), WALL_REPULSION * alpha, randValues, stepNumber);

	myPos += posDelta;

	// Clamp myPos to be within the walls
	// outputPositions[pointId] = clamp(myPos, (float2) (0.0f, 0.0f), dimensions);

	outputPositions[pointId] = myPos;

	return;
}


float2 calculatePointForce(float2 a, float2 b, float force, __constant float2* randValues, unsigned int randOffset) {
	// r = distance^2
	float2 d = (float2) ((b.x - a.x), (b.y - a.y));
	float r = (d.x * d.x) + (d.y * d.y);

	if(r < (FLT_EPSILON * FLT_EPSILON)) {
		b = randValues[(get_global_id(0) * randOffset) % RAND_LENGTH];

		d = (float2) ((b.x - a.x), (b.y - a.y));
		r = (d.x * d.x) + (d.y * d.y);
	}
	float k = force / r;

	return (float2) (d.x * k, d.y * k);
}


// __kernel void nbody2d_compute_springs(
// 	unsigned int numEdges,
// 	__global unsigned int* springList,
// 	__global float* springPositions,
// 	__global float* inputPositions,
// 	__global float* outputPositions,
// 	float timeDelta)
// {
// 	// From Hooke's Law, we generally have that the force exerted by a spring is given by
// 	//	F = -k * X, where X is the distance the spring has been displaced from it's natural
// 	// distance, and k is some constant positive real number.
// 	return;
// }


